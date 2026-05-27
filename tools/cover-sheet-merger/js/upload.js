// =====================================================================
// APS binary upload — pushes the merged file back to Forma as a NEW
// VERSION of the existing target item (.docx or .xlsx). This is the one flow not
// present in the TIDP uploader (which only clones placeholders via
// copyFrom), so it's implemented from the OSS + Data Management primitives:
//
//   1. Create a storage object in the main doc's parent folder.
//   2. Request a signed S3 upload URL for that object.
//   3. PUT the bytes straight to S3 (no Authorization header).
//   4. Complete the upload (finalises the OSS object).
//   5. POST a new `versions` entry on the existing item, pointing at the
//      storage object — Forma records it as the next version.
// =====================================================================

async function createStorageObject(token, project_id, folderId, filename) {
    const body = {
        jsonapi: { version: "1.0" },
        data: {
            type: "objects",
            attributes: { name: filename },
            relationships: { target: { data: { type: "folders", id: folderId } } },
        },
    };
    const apiUrl = "https://developer.api.autodesk.com/data/v1/projects/b." + project_id + "/storage";
    const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': "Bearer " + token,
            'Content-Type': 'application/vnd.api+json',
        },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || !data.data || !data.data.id) {
        throw new Error('Create-storage failed: ' + JSON.stringify(data));
    }
    return data.data.id; // storage urn
}

async function getSignedUploadUrl(token, bucketKey, objectKey) {
    const apiUrl = "https://developer.api.autodesk.com/oss/v2/buckets/" + bucketKey +
        "/objects/" + encodeURIComponent(objectKey) + "/signeds3upload";
    const resp = await fetch(apiUrl, { method: 'GET', headers: { 'Authorization': "Bearer " + token } });
    const data = await resp.json();
    if (!resp.ok || !data.urls || !data.urls[0] || !data.uploadKey) {
        throw new Error('Signed-upload request failed: ' + JSON.stringify(data));
    }
    return { url: data.urls[0], uploadKey: data.uploadKey };
}

// Uses XHR (not fetch) so we get real upload progress events for the byte
// transfer — this is the slow part, so a live bar here is what makes the
// modal feel responsive. onFraction receives 0..1.
function putBytesToS3(signedUrl, blob, onFraction) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', signedUrl);
        if (xhr.upload && onFraction) {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onFraction(e.loaded / e.total);
            };
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error('S3 upload failed (HTTP ' + xhr.status + ').'));
        };
        xhr.onerror = () => reject(new Error('S3 upload network error.'));
        xhr.send(blob);
    });
}

async function completeUpload(token, bucketKey, objectKey, uploadKey) {
    const apiUrl = "https://developer.api.autodesk.com/oss/v2/buckets/" + bucketKey +
        "/objects/" + encodeURIComponent(objectKey) + "/signeds3upload";
    const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': "Bearer " + token,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ uploadKey }),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error('Complete-upload failed (HTTP ' + resp.status + '): ' + text);
    }
}

async function createNewVersion(token, project_id, itemId, storageUrn, filename) {
    const body = {
        jsonapi: { version: "1.0" },
        data: {
            type: "versions",
            attributes: {
                name: filename,
                extension: { type: "versions:autodesk.bim360:File", version: "1.0" },
            },
            relationships: {
                item: { data: { type: "items", id: itemId } },
                storage: { data: { type: "objects", id: storageUrn } },
            },
        },
    };
    const apiUrl = "https://developer.api.autodesk.com/data/v1/projects/b." + project_id + "/versions";
    const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': "Bearer " + token,
            'Content-Type': 'application/vnd.api+json',
        },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || (data.errors && data.errors.length)) {
        throw new Error('Create-version failed: ' + JSON.stringify(data.errors || data));
    }
    return data;
}

// Public: upload `blob` as a new version of `mainFile` (which carries the
// item id, parent folder id, and original name). `onProgress(pct, label)` is
// an optional callback; this stage spans 45→100% of the overall flow (the
// merge stages before it cover 0→45%).
async function uploadAsNewVersion(blob, mainFile, onProgress) {
    const prog = onProgress || function () {};

    prog(46, 'Preparing upload…');
    const tokenCreate = await getAccessToken("data:create");
    const tokenWrite = await getAccessToken("data:write");

    prog(52, 'Creating storage…');
    const storageUrn = await createStorageObject(tokenCreate, projectID, mainFile.folderId, mainFile.name);
    const { bucketKey, objectKey } = parseStorageUrn(storageUrn);

    prog(57, 'Requesting upload URL…');
    const { url, uploadKey } = await getSignedUploadUrl(tokenWrite, bucketKey, objectKey);

    prog(60, 'Uploading to Forma…');
    await putBytesToS3(url, blob, (f) => {
        prog(60 + Math.round(f * 28), 'Uploading to Forma… ' + Math.round(f * 100) + '%');
    });

    prog(92, 'Finalising upload…');
    await completeUpload(tokenWrite, bucketKey, objectKey, uploadKey);

    prog(97, 'Creating new version…');
    await createNewVersion(tokenCreate, projectID, mainFile.id, storageUrn, mainFile.name);

    prog(100, 'Saved to Forma.');
}
