// =====================================================================
// Autodesk Forma (APS) data layer for the Cover Sheet Merger.
//
// Auth model mirrors the TIDP uploader:
//   - A 3-legged user login (login.js) gives us the user's identity, which
//     scopes the project list returned by the Power Automate proxy.
//   - All Data Management / OSS calls use 2-legged app tokens minted on
//     demand by the same Power Automate proxy (getAccessToken).
// =====================================================================

// --- Loading-screen checklist ----------------------------------------------
function setLoadingStep(stepId, state, label) {
    const ul = document.getElementById('loadingSteps');
    if (!ul) return;
    const li = ul.querySelector(`[data-step="${stepId}"]`);
    if (!li) return;
    li.classList.remove('pending', 'active', 'done');
    li.classList.add(state);
    const icon = li.querySelector('.step-icon');
    if (icon) icon.textContent = state === 'done' ? '✓' : '';
    if (label !== undefined) {
        const labelEl = li.querySelector('.step-label');
        if (labelEl) labelEl.textContent = label;
    }
}

function showLoadingScreen() {
    const el = document.getElementById('loadingScreen');
    if (el) el.style.display = 'flex';
}
function hideLoadingScreen() {
    const el = document.getElementById('loadingScreen');
    if (el) el.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function () {
    (async function gatherArrays() {
        showLoadingScreen();

        setLoadingStep('auth', 'active');
        await loginReady;
        setLoadingStep('auth', 'done');

        setLoadingStep('projects', 'active');
        try {
            await listProjects();
            setLoadingStep('projects', 'done');
        } catch (err) {
            console.error('Failed to load projects:', err);
            setLoadingStep('projects', 'done', 'Loading projects (failed)');
        }

        hideLoadingScreen();
    })();
});

// --- Token proxy (2-legged) -------------------------------------------------
async function getAccessToken(scopeInput) {
    const requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: scopeInput }),
    };
    const apiUrl = "https://default917b4d06d2e9475983a3e7369ed74e.8f.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/df0aebc4d2324e98bcfa94699154481f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=igiodIb-lGf7MTGYIlPATMr-JbyDeztuALW5F6IIaNs";
    return await fetch(apiUrl, requestOptions)
        .then(r => r.json())
        .then(d => d.access_token)
        .catch(e => { console.error('Error fetching token:', e); });
}

// --- Project list -----------------------------------------------------------
async function listProjects() {
    ProjectListRaw = await fetchProjects();
    ProjectList = [];
    for (let i = 0; i < ProjectListRaw.length; i++) {
        ProjectList.push({ ProjectName: ProjectListRaw[i].name, ProjectID: ProjectListRaw[i].id });
    }
    ProjectList.sort((a, b) => a.ProjectName.localeCompare(b.ProjectName));
    sessionStorage.setItem('ProjectList', JSON.stringify(ProjectList));

    // Hand off to the searchable combobox (merge.js) once the list is ready.
    if (typeof onProjectsLoaded === 'function') onProjectsLoaded(ProjectList);
}

async function fetchProjects() {
    const uid = sessionStorage.getItem('userID');
    const requestOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userID: uid, requestType: 'tidpUploader' }),
    };
    const apiUrl = "https://default917b4d06d2e9475983a3e7369ed74e.8f.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/30f57be09dd04690be4212eb4ed6df65/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=AKQMd6IhhtwV5Rid6zC7KTH3LPtniMWevgkP9UlSKko";
    return await fetch(apiUrl, requestOptions)
        .then(r => r.json())
        .catch(e => { console.error('Error fetching projects:', e); return []; });
}

// --- Folder / item reads ----------------------------------------------------
async function getProjectTopFolders(token, project_id) {
    const apiUrl = "https://developer.api.autodesk.com/project/v1/hubs/" + hubID +
        "/projects/b." + project_id + "/topFolders";
    return await fetch(apiUrl, { method: 'GET', headers: { 'Authorization': "Bearer " + token } })
        .then(r => r.json())
        .catch(e => { console.error('Error fetching top folders:', e); });
}

async function getFolderContents(token, project_id, folder_id) {
    const apiUrl = "https://developer.api.autodesk.com/data/v1/projects/b." + project_id +
        "/folders/" + folder_id + "/contents";
    return await fetch(apiUrl, { method: 'GET', headers: { 'Authorization': "Bearer " + token } })
        .then(r => r.json())
        .catch(e => { console.error('Error fetching folder contents:', e); });
}

// Returns { folders:[{id,name}], files:[{id,name,versionId}] } for a folder.
// All items are returned; callers filter by file extension (the unified tool
// shows .docx and .xlsx covers, then filters the target browser by type).
async function listFolder(token, project_id, folder_id) {
    const data = await getFolderContents(token, project_id, folder_id);
    const folders = [];
    const files = [];
    if (data && Array.isArray(data.data)) {
        for (const entry of data.data) {
            if (entry.type === 'folders') {
                folders.push({ id: entry.id, name: entry.attributes.name });
            } else if (entry.type === 'items') {
                const name = entry.attributes.displayName || entry.attributes.name || '';
                const versionId = entry.relationships
                    && entry.relationships.tip
                    && entry.relationships.tip.data
                    ? entry.relationships.tip.data.id : null;
                files.push({ id: entry.id, name, versionId });
            }
        }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { folders, files };
}

// Resolve the "Project Files" top folder id for the current project.
async function getProjectFilesFolderId(token, project_id) {
    const top = await getProjectTopFolders(token, project_id);
    if (!top || !Array.isArray(top.data)) return null;
    const pf = top.data.find(f => (f.attributes && f.attributes.name) === 'Project Files');
    return pf ? pf.id : null;
}

// Walk a fixed path (array of folder names) starting from a folder id.
// Returns the final folder id, or null if any segment is missing.
async function resolveFolderByPath(token, project_id, startFolderId, pathSegments) {
    let current = startFolderId;
    for (const segment of pathSegments) {
        const { folders } = await listFolder(token, project_id, current);
        const match = folders.find(f => f.name === segment);
        if (!match) return null;
        current = match.id;
    }
    return current;
}

// --- Download a file's tip-version bytes as a Blob --------------------------
async function getVersionStorageUrn(token, project_id, versionId) {
    const apiUrl = "https://developer.api.autodesk.com/data/v1/projects/b." + project_id +
        "/versions/" + encodeURIComponent(versionId);
    const data = await fetch(apiUrl, { method: 'GET', headers: { 'Authorization': "Bearer " + token } })
        .then(r => r.json())
        .catch(e => { console.error('Error fetching version:', e); });
    if (data && data.data && data.data.relationships
        && data.data.relationships.storage && data.data.relationships.storage.data) {
        return data.data.relationships.storage.data.id;
    }
    return null;
}

// storage urn looks like: urn:adsk.objects:os.object:<bucketKey>/<objectKey>
function parseStorageUrn(storageUrn) {
    const marker = 'os.object:';
    const idx = storageUrn.indexOf(marker);
    if (idx === -1) throw new Error('Unrecognised storage URN: ' + storageUrn);
    const rest = storageUrn.substring(idx + marker.length); // bucketKey/objectKey
    const slash = rest.indexOf('/');
    return { bucketKey: rest.substring(0, slash), objectKey: rest.substring(slash + 1) };
}

async function getSignedDownloadUrl(token, bucketKey, objectKey) {
    const apiUrl = "https://developer.api.autodesk.com/oss/v2/buckets/" + bucketKey +
        "/objects/" + encodeURIComponent(objectKey) + "/signeds3download";
    const data = await fetch(apiUrl, { method: 'GET', headers: { 'Authorization': "Bearer " + token } })
        .then(r => r.json())
        .catch(e => { console.error('Error fetching signed download URL:', e); });
    if (!data || !data.url) throw new Error('No signed download URL returned.');
    return data.url;
}

// Public: given a file {versionId}, return its bytes as a Blob.
async function downloadFileBlob(file) {
    const token = await getAccessToken("data:read");
    const storageUrn = await getVersionStorageUrn(token, projectID, file.versionId);
    if (!storageUrn) throw new Error('Could not resolve storage for "' + file.name + '".');
    const { bucketKey, objectKey } = parseStorageUrn(storageUrn);
    const url = await getSignedDownloadUrl(token, bucketKey, objectKey);
    const resp = await fetch(url); // presigned S3 GET — no auth header
    if (!resp.ok) throw new Error('Download failed (HTTP ' + resp.status + ') for "' + file.name + '".');
    return await resp.blob();
}
