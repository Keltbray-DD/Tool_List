// =====================================================================
// Cover Sheet Merger — unified Word + Excel, orchestration + UI + engines.
//
// Forma-only flow. The cover file (from 0B.GENERAL/COVER_SHEETS, or a desktop
// fallback) decides the workflow by its extension:
//   .docx -> mergeDocx prepends the cover onto a target Word document.
//   .xlsx -> mergeXlsx copies the cover's COVER_SHEET tab into a target
//            Excel workbook as the first tab.
// The target browser is filtered to the matching type. The result is uploaded
// straight back to Forma as a new version of the target (never downloaded).
//
// Both engines do XML surgery via JSZip, leaving the target's other content
// untouched. mergeDocx is near the top of the engine section; mergeXlsx below.
// =====================================================================

(function () {
  // --- State ----------------------------------------------------------------
  let coverFiles = [];        // [{id,name,versionId,folderId}] from COVER_SHEETS
  let coverFolderId = null;   // null => folder missing, cover desktop fallback active
  let coverDesktopFile = null;// cover picked from disk (fallback only)
  let projectFilesId = null;  // browse root
  let browseStack = [];       // [{id,name}] breadcrumb ([0] = Project Files)
  let selectedTargets = [];   // [{id,name,versionId,folderId}] — current folder only
  let selectionFolderId = null; // folder the current selection belongs to
  let workflowType = null;    // 'word' | 'excel' | 'pdf' | 'pptx' — from the cover

  let busy = false;

  // --- Element refs ---------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  // --- Type helpers ---------------------------------------------------------
  function extOf(name) { return (String(name).match(/\.[^.]+$/) || [''])[0].toLowerCase(); }
  function typeForExt(ext) {
    if (ext === '.docx') return 'word';
    if (ext === '.xlsx') return 'excel';
    if (ext === '.pdf') return 'pdf';
    if (ext === '.pptx') return 'pptx';
    return null;
  }
  function extForType(type) {
    if (type === 'excel') return '.xlsx';
    if (type === 'pdf') return '.pdf';
    if (type === 'pptx') return '.pptx';
    return '.docx';
  }
  function typeNoun(type) {
    if (type === 'excel') return 'Excel workbook';
    if (type === 'pdf') return 'PDF';
    if (type === 'pptx') return 'PowerPoint presentation';
    return 'Word document';
  }

  function setStatus(msg, kind) {
    const el = $('status');
    if (!el) return;
    el.className = 'merge-status show ' + (kind || 'info');
    el.innerHTML = msg;
  }
  function clearStatus() {
    const el = $('status');
    if (!el) return;
    el.className = 'merge-status';
    el.innerHTML = '';
  }

  function clearSelection() {
    selectedTargets = [];
    selectionFolderId = null;
    updateSelectedCount();
  }
  function updateSelectedCount() {
    const el = $('mainSelected');
    if (!el) return;
    const n = selectedTargets.length;
    el.textContent = n === 0 ? '' : (n === 1 ? '1 file selected' : n + ' files selected');
  }

  function setBusy(b) {
    busy = b;
    $('mergeUploadBtn').disabled = b;
  }

  // --- Project selection ----------------------------------------------------
  async function selectProject(id, name) {
    projectID = id;
    projectName = name || '';
    coverFiles = [];
    coverFolderId = null;
    coverDesktopFile = null;
    workflowType = null;
    projectFilesId = null;
    browseStack = [];
    clearSelection();
    updateMergeBtn();

    if (!projectID) {
      $('coverSelect').innerHTML = '<option value="">Select a project first…</option>';
      $('folderList').innerHTML = '';
      $('folderBreadcrumb').textContent = '';
      return;
    }

    // Immediate loading feedback so the user knows the empty areas are filling.
    $('coverFallback').style.display = 'none';
    $('coverSelect').style.display = '';
    $('coverSelect').innerHTML = '<option value="">Loading cover files…</option>';
    $('coverSelectLabel').textContent = 'Cover file:';
    $('folderBreadcrumb').innerHTML = '<span class="browse-loading"><span class="mini-spinner"></span>Loading…</span>';
    $('folderList').innerHTML = '<div class="browse-loading"><span class="mini-spinner"></span>Loading folders from Forma…</div>';
    setStatus('Loading project folders from Forma…', 'info');
    try {
      const token = await getAccessToken("data:read");
      projectFilesId = await getProjectFilesFolderId(token, projectID);
      if (!projectFilesId) throw new Error('Could not find the "Project Files" folder for this project.');

      // Resolve the fixed cover-sheets folder; fall back to desktop if absent.
      coverFolderId = await resolveFolderByPath(token, projectID, projectFilesId, COVER_SHEETS_PATH);
      await populateCoverOptions(token);

      // Pre-resolve the browse root (default to 0C.WIP). The file list itself
      // isn't shown until a cover is chosen, since its type filters the target.
      browseStack = [{ id: projectFilesId, name: 'Project Files' }];
      const { folders } = await listFolder(token, projectID, projectFilesId);
      const wip = folders.find(f => /^0c\.wip\b/i.test(f.name) || f.name === '0C.WIP');
      if (wip) browseStack.push({ id: wip.id, name: wip.name });

      showBrowserPlaceholder();
      clearStatus();
    } catch (err) {
      console.error(err);
      setStatus('Couldn’t load this project: ' + err.message, 'error');
    }
  }

  function showBrowserPlaceholder() {
    $('folderBreadcrumb').textContent = '';
    $('folderList').innerHTML = '<div class="browse-empty">Pick a cover file above first — the target list is filtered to match its type.</div>';
  }

  // --- Searchable project combobox ------------------------------------------
  let comboProjects = [];
  let comboActive = -1;

  // Called by acc.js once the project list has loaded.
  window.onProjectsLoaded = function (list) {
    comboProjects = list || [];
    const input = $('projectSearch');
    input.disabled = false;
    input.placeholder = 'Search ' + comboProjects.length + ' projects…';
  };

  function setupProjectCombo() {
    const input = $('projectSearch');
    const list = $('projectList');

    const open = () => { renderProjectList(input.value); list.hidden = false; };
    const close = () => { list.hidden = true; comboActive = -1; };

    input.addEventListener('focus', open);
    input.addEventListener('input', () => {
      // Typing invalidates any committed selection until they pick again.
      if (projectID) selectProject('', '');
      comboActive = -1;
      open();
    });
    input.addEventListener('keydown', (e) => {
      const rows = Array.from(list.querySelectorAll('.combo-row'));
      if (e.key === 'ArrowDown') { e.preventDefault(); comboActive = Math.min(comboActive + 1, rows.length - 1); paintActive(rows); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); comboActive = Math.max(comboActive - 1, 0); paintActive(rows); }
      else if (e.key === 'Enter') { e.preventDefault(); if (rows[comboActive]) rows[comboActive].click(); }
      else if (e.key === 'Escape') { close(); }
    });

    document.addEventListener('click', (e) => {
      if (!$('projectCombo').contains(e.target)) close();
    });
  }

  function paintActive(rows) {
    rows.forEach((r, i) => r.classList.toggle('active', i === comboActive));
    if (rows[comboActive]) rows[comboActive].scrollIntoView({ block: 'nearest' });
  }

  function renderProjectList(query) {
    const list = $('projectList');
    const q = (query || '').trim().toLowerCase();
    const matches = q
      ? comboProjects.filter(p => p.ProjectName.toLowerCase().includes(q))
      : comboProjects;
    if (matches.length === 0) {
      list.innerHTML = '<div class="combo-empty">No matching projects</div>';
      return;
    }
    list.innerHTML = '';
    matches.slice(0, 200).forEach(p => {
      const row = document.createElement('div');
      row.className = 'combo-row';
      row.textContent = p.ProjectName;
      row.addEventListener('click', () => {
        $('projectSearch').value = p.ProjectName;
        list.hidden = true;
        comboActive = -1;
        selectProject(p.ProjectID, p.ProjectName);
      });
      list.appendChild(row);
    });
  }

  async function populateCoverOptions(token) {
    const select = $('coverSelect');
    const fallback = $('coverFallback');
    if (!coverFolderId) {
      // Folder missing — show desktop fallback for the cover file.
      select.style.display = 'none';
      $('coverSelectLabel').textContent =
        'No 0B.GENERAL/COVER_SHEETS folder in this project — choose a cover file (.docx or .xlsx) from your computer:';
      fallback.style.display = '';
      return;
    }
    fallback.style.display = 'none';
    select.style.display = '';
    $('coverSelectLabel').textContent = 'Cover file (.docx or .xlsx, from 0B.GENERAL/COVER_SHEETS):';
    const { files } = await listFolder(token, projectID, coverFolderId);
    // Only supported document types are offered as covers.
    coverFiles = files
      .filter(f => SUPPORTED_EXTS.includes(extOf(f.name)))
      .map(f => ({ ...f, folderId: coverFolderId }));
    if (coverFiles.length === 0) {
      select.innerHTML = '<option value="">No .docx or .xlsx cover files found in the folder</option>';
    } else {
      select.innerHTML = '<option value="">Select a cover file…</option>' +
        coverFiles.map((f, i) => `<option value="${i}">${escapeHtml(f.name)}</option>`).join('');
    }
  }

  // The chosen cover's extension decides the workflow (Word vs Excel), which in
  // turn filters the target browser and selects the merge engine.
  async function onCoverChosen() {
    const ext = coverFolderId
      ? (($('coverSelect').value !== '') ? extOf(coverFiles[parseInt($('coverSelect').value, 10)].name) : null)
      : (coverDesktopFile ? extOf(coverDesktopFile.name) : null);
    const newType = typeForExt(ext);

    // Changing type invalidates any previously chosen target.
    if (newType !== workflowType) clearSelection();
    workflowType = newType;
    setTargetLabel();

    if (!workflowType) {
      showBrowserPlaceholder();
    } else if (projectFilesId) {
      await renderBrowser();
    }
    updateMergeBtn();
  }

  function setTargetLabel() {
    const label = $('targetLabel');
    if (!label) return;
    if (!workflowType) {
      label.textContent = 'Target files — pick a cover file above first:';
    } else {
      label.textContent = 'Target ' + typeNoun(workflowType) + 's (' + extForType(workflowType) +
        ') — tick one or more in the current folder:';
    }
  }

  // --- Lazy folder browser (target file) ------------------------------------
  async function renderBrowser() {
    if (!workflowType) { showBrowserPlaceholder(); return; }
    const wantExt = extForType(workflowType);
    $('folderList').innerHTML = '<div class="browse-loading"><span class="mini-spinner"></span>Loading…</div>';
    const token = await getAccessToken("data:read");
    const current = browseStack[browseStack.length - 1];
    // Selection is scoped to one folder — moving to a different folder clears it.
    if (selectionFolderId !== current.id) { selectedTargets = []; selectionFolderId = current.id; updateSelectedCount(); updateMergeBtn(); }
    const all = await listFolder(token, projectID, current.id);
    const folders = all.folders;
    const files = all.files.filter(f => extOf(f.name) === wantExt);

    // Breadcrumb
    const bc = $('folderBreadcrumb');
    bc.innerHTML = '';
    browseStack.forEach((node, idx) => {
      if (idx > 0) bc.appendChild(document.createTextNode(' / '));
      if (idx < browseStack.length - 1) {
        const a = document.createElement('a');
        a.href = '#';
        a.textContent = node.name;
        a.className = 'crumb';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          browseStack = browseStack.slice(0, idx + 1);
          renderBrowser();
        });
        bc.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.className = 'crumb crumb--current';
        span.textContent = node.name;
        bc.appendChild(span);
      }
    });

    // List
    const list = $('folderList');
    list.innerHTML = '';
    if (folders.length === 0 && files.length === 0) {
      list.innerHTML = '<div class="browse-empty">No subfolders or ' + extForType(workflowType) + ' files here.</div>';
      return;
    }
    folders.forEach(f => {
      const row = document.createElement('div');
      row.className = 'browse-row browse-row--folder';
      row.innerHTML = '<span class="browse-icon">📁</span>' + escapeHtml(f.name);
      row.addEventListener('click', () => {
        browseStack.push({ id: f.id, name: f.name });
        renderBrowser(); // new folder → selection clears via selectionFolderId check
      });
      list.appendChild(row);
    });
    files.forEach(f => {
      const isSel = selectedTargets.some(t => t.id === f.id);
      const row = document.createElement('div');
      row.className = 'browse-row browse-row--file' + (isSel ? ' is-selected' : '');
      const check = document.createElement('span');
      check.className = 'browse-check';
      check.textContent = isSel ? '☑' : '☐';
      row.appendChild(check);
      const icon = document.createElement('span');
      icon.className = 'browse-icon';
      icon.textContent = '📄';
      row.appendChild(icon);
      row.appendChild(document.createTextNode(f.name));
      row.addEventListener('click', () => {
        // Toggle selection in place — no re-fetch.
        const i = selectedTargets.findIndex(t => t.id === f.id);
        const nowSel = i < 0;
        if (nowSel) selectedTargets.push({ ...f, folderId: current.id });
        else selectedTargets.splice(i, 1);
        row.classList.toggle('is-selected', nowSel);
        check.textContent = nowSel ? '☑' : '☐';
        updateSelectedCount();
        updateMergeBtn();
      });
      list.appendChild(row);
    });
  }

  // --- Merge enablement -----------------------------------------------------
  // What's still missing before a merge can run, as a human-readable list.
  function missingRequirements() {
    const missing = [];
    if (!projectID) missing.push('a project');
    const haveCover = coverFolderId ? ($('coverSelect').value !== '') : !!coverDesktopFile;
    if (!haveCover) missing.push('a cover file');
    if (selectedTargets.length === 0) missing.push('at least one target file');
    return missing;
  }

  function listToText(arr) {
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
  }

  // Click-time guard: if not ready, say exactly what's missing instead of
  // doing nothing silently.
  function ensureReady() {
    const missing = missingRequirements();
    if (missing.length) {
      setStatus('Please select ' + listToText(missing) + ' first.', 'error');
      return false;
    }
    return true;
  }

  // Buttons stay clickable so they always give feedback; the hint line shows
  // live what's still needed (or "Ready to merge").
  function updateMergeBtn() {
    const missing = missingRequirements();
    const hint = $('mergeHint');
    if (missing.length) {
      hint.textContent = 'To merge, first select ' + listToText(missing) + '.';
      hint.classList.remove('ready');
    } else {
      hint.textContent = '✓ Ready to merge.';
      hint.classList.add('ready');
    }
  }

  // --- Cover + merge --------------------------------------------------------
  // Download (or read) the cover file once; reused for every target.
  async function getCoverBlob() {
    if (coverFolderId) {
      const idx = parseInt($('coverSelect').value, 10);
      return await downloadFileBlob(coverFiles[idx]);
    }
    return coverDesktopFile;
  }

  // Merge the cover into one target file; returns the merged Blob.
  // onProgress(pct,label) spans 0→45 (upload takes 45→100).
  async function mergeCoverInto(coverBlob, targetFile, onProgress) {
    const prog = onProgress || function () {};
    prog(8, 'Downloading from Forma…');
    const targetBlob = await downloadFileBlob(targetFile);
    if (workflowType === 'excel') { prog(34, 'Copying COVER_SHEET tab…'); return await mergeXlsx(coverBlob, targetBlob); }
    if (workflowType === 'pdf')   { prog(34, 'Adding cover page…');       return await mergePdf(coverBlob, targetBlob); }
    if (workflowType === 'pptx')  { prog(34, 'Adding cover slide…');      return await mergePptx(coverBlob, targetBlob); }
    prog(34, 'Merging…'); return await mergeDocx(coverBlob, targetBlob);
  }

  // --- Batch run: one cover → every selected target -------------------------
  async function runBatch() {
    setBusy(true);
    const targets = selectedTargets.slice();
    showModalBatch(targets);
    let ok = 0, failed = 0;
    let coverBlob;
    try {
      coverBlob = await getCoverBlob();
    } catch (err) {
      console.error(err);
      targets.forEach((t, i) => setRowError(i, 'Could not load the cover file.'));
      finishBatch(0, targets.length);
      setBusy(false);
      return;
    }
    for (let i = 0; i < targets.length; i++) {
      const tf = targets[i];
      const prog = (pct, label) => setRowProgress(i, pct, label);
      try {
        const blob = await mergeCoverInto(coverBlob, tf, prog);
        await uploadAsNewVersion(blob, tf, prog);
        setRowDone(i, tf);
        ok++;
      } catch (err) {
        console.error('Failed on ' + tf.name + ':', err);
        setRowError(i, err && err.message ? err.message : String(err));
        failed++;
      }
    }
    finishBatch(ok, failed);
    setBusy(false);
    updateMergeBtn();
  }

  // --- Confirm + batch modal ------------------------------------------------
  function openConfirm() {
    if (!ensureReady()) return;
    $('confirmQuestion').hidden = false;
    $('confirmBatch').hidden = true;
    const n = selectedTargets.length;
    let verb;
    if (workflowType === 'excel') verb = 'copy the COVER_SHEET tab into';
    else if (workflowType === 'pdf') verb = 'add the cover page to the front of';
    else if (workflowType === 'pptx') verb = 'add the cover slide to the front of';
    else verb = 'add the cover sheet to';
    const what = n === 1 ? 'this ' + typeNoun(workflowType) : n + ' ' + typeNoun(workflowType) + 's';
    $('confirmMsg').innerHTML =
      'This will ' + verb + ' <strong>' + what + '</strong> and upload the result ' +
      '<strong>directly to Forma</strong> as a new version of each — in one step. ' +
      'The originals stay in Forma’s version history.';
    $('confirmOverlay').hidden = false;
  }
  function closeConfirm() { $('confirmOverlay').hidden = true; }

  // Build one progress row per target and switch the modal to batch view.
  function showModalBatch(targets) {
    $('confirmQuestion').hidden = true;
    $('confirmBatch').hidden = false;
    $('batchFooter').hidden = true;
    $('batchTitle').textContent = 'Saving to Forma…';
    const list = $('batchList');
    list.innerHTML = '';
    targets.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'batch-row';
      row.id = 'batchRow' + i;
      row.innerHTML =
        '<div class="batch-row__name"><span class="batch-row__file"></span></div>' +
        '<div class="cs-progress"><div class="cs-progress__bar"></div></div>' +
        '<div class="batch-row__status">Waiting…</div>';
      row.querySelector('.batch-row__file').textContent = t.name;
      list.appendChild(row);
    });
  }
  function setRowProgress(i, pct, label) {
    const row = $('batchRow' + i);
    if (!row) return;
    row.querySelector('.cs-progress__bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    const st = row.querySelector('.batch-row__status');
    st.className = 'batch-row__status';
    st.textContent = label || '';
  }
  function setRowDone(i, tf) {
    const row = $('batchRow' + i);
    if (!row) return;
    row.querySelector('.cs-progress__bar').style.width = '100%';
    const nameEl = row.querySelector('.batch-row__name');
    const url = formaFileUrl(tf.id);
    if (url) {
      nameEl.innerHTML = '<a class="batch-link" href="' + url + '" target="_blank" rel="noopener">' +
        escapeHtml(tf.name) + '</a>';
    }
    const st = row.querySelector('.batch-row__status');
    st.className = 'batch-row__status ok';
    st.textContent = '✓ Saved new version' + (url ? ' — click the name to open in Forma' : '');
  }
  function setRowError(i, msg) {
    const row = $('batchRow' + i);
    if (!row) return;
    const st = row.querySelector('.batch-row__status');
    st.className = 'batch-row__status err';
    st.textContent = '✗ ' + msg;
  }
  function finishBatch(ok, failed) {
    $('batchTitle').textContent = failed === 0
      ? (ok === 1 ? 'Saved to Forma' : 'All ' + ok + ' saved to Forma')
      : (ok + ' saved, ' + failed + ' failed');
    $('batchFooter').hidden = false;
  }

  // "Merge more": keep project + cover, clear the target selection for a fresh batch.
  function doAnother() {
    closeConfirm();
    clearSelection();
    clearStatus();
    updateMergeBtn();
    if (projectFilesId && workflowType) renderBrowser();
  }

  // Build a link that opens the document in Forma/ACC. {project}=project GUID,
  // {item}=item lineage URN. Returns null if no template is configured.
  function formaFileUrl(itemUrn) {
    if (typeof FORMA_FILE_URL !== 'string' || !FORMA_FILE_URL || !projectID || !itemUrn) return null;
    return FORMA_FILE_URL
      .replace('{project}', encodeURIComponent(projectID))
      .replace('{item}', encodeURIComponent(itemUrn));
  }

  // --- Desktop dropzones -----------------------------------------------------
  function wireDropzone(zoneId, inputId, onPick) {
    const zone = $(zoneId);
    const input = $(inputId);
    if (!zone || !input) return;
    input.addEventListener('change', (e) => onPick(e.target.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      onPick(e.dataTransfer.files[0]);
    });
  }

  function validCover(file) {
    if (!file) return false;
    if (!SUPPORTED_EXTS.includes(extOf(file.name))) {
      setStatus('Please choose a .docx, .xlsx, .pdf or .pptx cover file.', 'error');
      return false;
    }
    return true;
  }

  // --- Init -----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    setupProjectCombo();
    $('coverSelect').addEventListener('change', onCoverChosen);

    // Cover desktop fallback — only used when a project has no COVER_SHEETS folder.
    wireDropzone('coverFallbackZone', 'coverFallbackInput', (file) => {
      if (!validCover(file)) return;
      coverDesktopFile = file;
      $('coverFallbackName').textContent = file.name;
      $('coverFallbackZone').classList.add('has-file');
      clearStatus();
      onCoverChosen();
    });

    $('mergeUploadBtn').addEventListener('click', openConfirm);
    $('confirmNo').addEventListener('click', () => { if (!busy) closeConfirm(); });
    $('confirmYes').addEventListener('click', runBatch);
    $('doneAnother').addEventListener('click', () => { if (!busy) doAnother(); });
    $('doneClose').addEventListener('click', () => { if (!busy) closeConfirm(); });
    $('confirmOverlay').addEventListener('click', (e) => {
      if (e.target === $('confirmOverlay') && !busy) closeConfirm();
    });
    $('resetBtn').addEventListener('click', () => location.reload());

    updateMergeBtn();
  });

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // =====================================================================
  // PDF merge engine — prepend the cover PDF's first page to the front of
  // the target PDF, via pdf-lib (global PDFLib). The target's own pages,
  // bookmarks and metadata are otherwise preserved.
  // =====================================================================
  async function mergePdf(coverFile, targetFile) {
    if (typeof PDFLib === 'undefined') throw new Error('PDF library failed to load.');
    const PDFDocument = PDFLib.PDFDocument;
    const toBytes = async (b) => (b && b.arrayBuffer) ? new Uint8Array(await b.arrayBuffer()) : b;

    const coverDoc = await PDFDocument.load(await toBytes(coverFile), { ignoreEncryption: true });
    const targetDoc = await PDFDocument.load(await toBytes(targetFile), { ignoreEncryption: true });

    if (coverDoc.getPageCount() === 0) throw new Error('The cover PDF has no pages.');

    // Copy the cover's first page into the target and insert it at the front.
    const [coverPage] = await targetDoc.copyPages(coverDoc, [0]);
    targetDoc.insertPage(0, coverPage);

    const outBytes = await targetDoc.save();
    return new Blob([outBytes], { type: 'application/pdf' });
  }

  // =====================================================================
  // Docx merge engine — identical logic to the standalone tool.
  // =====================================================================
  async function mergeDocx(coverFile, mainFile) {
    const coverZip = await JSZip.loadAsync(coverFile);
    const mainZip = await JSZip.loadAsync(mainFile);

    const out = new JSZip();
    const filePaths = Object.keys(mainZip.files);
    for (const path of filePaths) {
      if (mainZip.files[path].dir) continue;
      const buf = await mainZip.files[path].async('uint8array');
      out.file(path, buf);
    }

    const mainDocXml = await mainZip.file('word/document.xml').async('string');
    const coverDocXml = await coverZip.file('word/document.xml').async('string');

    const mainRelsXml = await readOrDefault(mainZip, 'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
    const coverRelsXml = await readOrDefault(coverZip, 'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');

    let maxRid = 0;
    for (const m of mainRelsXml.matchAll(/Id="rId(\d+)"/g)) {
      const n = parseInt(m[1], 10);
      if (n > maxRid) maxRid = n;
    }

    const SKIP_REL_TYPES = new Set([
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml',
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/glossaryDocument'
    ]);

    const ridMap = new Map();
    const droppedRids = new Set();
    const newRels = [];
    const mediaRename = new Map();

    const relRegex = /<Relationship\s+([^>]+?)\/?>/g;
    let relMatch;
    while ((relMatch = relRegex.exec(coverRelsXml)) !== null) {
      const attrs = relMatch[1];
      const id = (attrs.match(/Id="([^"]+)"/) || [])[1];
      const type = (attrs.match(/Type="([^"]+)"/) || [])[1];
      const target = (attrs.match(/Target="([^"]+)"/) || [])[1];
      const mode2 = (attrs.match(/TargetMode="([^"]+)"/) || [])[1];
      if (!id || !type || !target) continue;

      if (SKIP_REL_TYPES.has(type)) { droppedRids.add(id); continue; }

      // Only carry over cover relationships actually referenced by the cover's
      // body content (images, hyperlinks, embedded objects). Document-level
      // singletons the main document already provides (styles, fontTable,
      // settings, and Microsoft extensions like stylesWithEffects) are NOT
      // referenced by r:id in the body — re-adding them creates duplicate
      // relationships that Word rejects as corrupt.
      const refRe = new RegExp('(?:r:id|r:embed|r:link|r:pict|r:dataPic|r:href|r:cs)="' + id + '"');
      if (!refRe.test(coverDocXml)) { droppedRids.add(id); continue; }

      const newId = 'rId' + (++maxRid);
      ridMap.set(id, newId);

      let newTarget = target;
      if (/^media\//i.test(target) || target.startsWith('media/')) {
        const filename = target.replace(/^media\//i, '');
        const newName = uniqueMediaName(filename, out);
        if (newName !== filename) mediaRename.set(filename, newName);
        newTarget = 'media/' + newName;
      }
      newRels.push({ id: newId, type, target: newTarget, mode: mode2 });
    }

    const mediaExts = new Set();
    for (const path of Object.keys(coverZip.files)) {
      if (!/^word\/media\//i.test(path)) continue;
      if (coverZip.files[path].dir) continue;
      const filename = path.replace(/^word\/media\//i, '');
      const targetName = mediaRename.get(filename) || filename;
      const outPath = 'word/media/' + targetName;
      const extMatch = targetName.match(/\.([^.]+)$/);
      if (extMatch) mediaExts.add(extMatch[1].toLowerCase());
      if (out.file(outPath)) continue;
      const buf = await coverZip.files[path].async('uint8array');
      out.file(outPath, buf);
    }

    await ensureContentTypeDefaults(out, mediaExts);

    let newRelsXml = mainRelsXml.replace(/<\/Relationships>\s*$/, '');
    for (const r of newRels) {
      let attrs = 'Id="' + r.id + '" Type="' + r.type + '" Target="' + escapeAttr(r.target) + '"';
      if (r.mode) attrs += ' TargetMode="' + r.mode + '"';
      newRelsXml += '<Relationship ' + attrs + '/>';
    }
    newRelsXml += '</Relationships>';
    out.file('word/_rels/document.xml.rels', newRelsXml);

    let processedCoverXml = coverDocXml;
    processedCoverXml = remapRids(processedCoverXml, ridMap);
    processedCoverXml = stripDroppedRefs(processedCoverXml, droppedRids);

    const coverBodyMatch = processedCoverXml.match(/<w:body[^>]*>([\s\S]*?)<\/w:body>/);
    if (!coverBodyMatch) throw new Error('Could not parse cover sheet structure.');
    let coverBody = coverBodyMatch[1];

    let coverSectPr = '';
    const terminalSectPrMatch = coverBody.match(/<w:sectPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:sectPr>)\s*$/);
    if (terminalSectPrMatch) {
      coverSectPr = terminalSectPrMatch[0].trim();
      coverBody = coverBody.substring(0, terminalSectPrMatch.index).trimEnd();
    }
    coverSectPr = ensureNextPage(coverSectPr);

    const sectionBreakPara = '<w:p><w:pPr>' + coverSectPr + '</w:pPr></w:p>';

    const bodyOpenMatch = mainDocXml.match(/<w:body[^>]*>/);
    if (!bodyOpenMatch) throw new Error('Could not parse main document structure.');
    const insertAt = bodyOpenMatch.index + bodyOpenMatch[0].length;
    const newDocXml =
      mainDocXml.substring(0, insertAt) + coverBody + sectionBreakPara + mainDocXml.substring(insertAt);

    out.file('word/document.xml', newDocXml);

    return await out.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      compression: 'DEFLATE'
    });
  }

  async function readOrDefault(zip, path, fallback) {
    const f = zip.file(path);
    if (!f) return fallback;
    return await f.async('string');
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function uniqueMediaName(filename, outZip) {
    if (!outZip.file('word/media/' + filename)) return filename;
    const dot = filename.lastIndexOf('.');
    const base = dot >= 0 ? filename.substring(0, dot) : filename;
    const ext = dot >= 0 ? filename.substring(dot) : '';
    let i = 1, candidate;
    do { candidate = base + '_cover' + i + ext; i++; }
    while (outZip.file('word/media/' + candidate));
    return candidate;
  }
  function remapRids(xml, ridMap) {
    if (ridMap.size === 0) return xml;
    return xml.replace(
      /(r:(?:id|embed|link|pict|dataPic|href|cs)|relationships:id)="([^"]+)"/g,
      (match, attr, val) => ridMap.has(val) ? attr + '="' + ridMap.get(val) + '"' : match
    );
  }
  function stripDroppedRefs(xml, droppedRids) {
    if (droppedRids.size === 0) return xml;
    return xml.replace(
      /<w:(?:headerReference|footerReference|footnoteReference|endnoteReference)\b[^>]*?r:id="([^"]+)"[^>]*?\/>/g,
      (match, rid) => droppedRids.has(rid) ? '' : match
    );
  }
  async function ensureContentTypeDefaults(zip, extensions) {
    if (!extensions || extensions.size === 0) return;
    const ctFile = zip.file('[Content_Types].xml');
    if (!ctFile) return;
    let xml = await ctFile.async('string');
    const mimeMap = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
      webp: 'image/webp', emf: 'image/x-emf', wmf: 'image/x-wmf', ico: 'image/x-icon'
    };
    let mutated = false;
    for (const ext of extensions) {
      const hasEntry = new RegExp('<Default\\b[^>]*Extension="' + ext + '"', 'i').test(xml);
      if (hasEntry) continue;
      const mime = mimeMap[ext] || 'application/octet-stream';
      const tag = '<Default Extension="' + ext + '" ContentType="' + mime + '"/>';
      if (/<Override\b/.test(xml)) xml = xml.replace(/<Override\b/, tag + '<Override');
      else xml = xml.replace(/<\/Types>\s*$/, tag + '</Types>');
      mutated = true;
    }
    if (mutated) zip.file('[Content_Types].xml', xml);
  }
  function ensureNextPage(sectPrXml) {
    if (!sectPrXml) return '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>';
    if (/<w:type\b/.test(sectPrXml)) {
      return sectPrXml.replace(/<w:type\b[^/>]*\/>/, '<w:type w:val="nextPage"/>');
    }
    return sectPrXml.replace(/<w:sectPr\b([^>]*)>/, '<w:sectPr$1><w:type w:val="nextPage"/>');
  }

  // =====================================================================
  // XLSX merge engine — copy the COVER_SHEET worksheet from the cover
  // workbook into the target workbook as the FIRST tab, leaving every
  // existing part of the target byte-identical. No library round-trip:
  // we inline the cover sheet's shared strings, merge + re-index its
  // styles into the target, carry its drawing/logo media, then register
  // the new sheet in workbook.xml / rels / [Content_Types].xml.
  // =====================================================================
  async function mergeXlsx(coverFile, targetFile) {
    const coverZip = await JSZip.loadAsync(coverFile);
    const targetZip = await JSZip.loadAsync(targetFile);

    // Clone the target verbatim — we only ADD parts / append to a few.
    const out = new JSZip();
    for (const path of Object.keys(targetZip.files)) {
      if (targetZip.files[path].dir) continue;
      out.file(path, await targetZip.files[path].async('uint8array'));
    }

    // 1) Locate the cover's COVER_SHEET worksheet part.
    const coverWbXml = await readStr(coverZip, 'xl/workbook.xml');
    const coverWbRels = await readStr(coverZip, 'xl/_rels/workbook.xml.rels');
    const coverSheetEl = matchSheetByName(coverWbXml, COVER_TAB_NAME);
    if (!coverSheetEl) throw new Error('The cover workbook has no tab named "' + COVER_TAB_NAME + '".');
    const coverSheetRid = (coverSheetEl.match(/r:id="([^"]+)"/) || [])[1];
    const coverSheetTarget = relTarget(coverWbRels, coverSheetRid);
    if (!coverSheetTarget) throw new Error('Could not resolve the COVER_SHEET worksheet relationship.');
    const coverSheetPath = resolveXlPath(coverSheetTarget);
    let sheetXml = await readStr(coverZip, coverSheetPath);
    if (!sheetXml) throw new Error('COVER_SHEET worksheet file not found in the cover workbook.');

    // 2) Inline the cover's shared strings (avoids merging string tables).
    const coverSST = await readSharedStrings(coverZip);
    sheetXml = inlineSharedStrings(sheetXml, coverSST);

    // 3) Merge styles into the target and remap the sheet's style indices.
    sheetXml = await mergeStylesAndRemap(coverZip, out, sheetXml);

    // 4) Carry over the sheet's drawing + logo image (if any).
    const newSheetNum = nextSheetNumber(out);
    const newSheetFile = 'xl/worksheets/sheet' + newSheetNum + '.xml';
    sheetXml = await carryDrawing(coverZip, out, coverSheetPath, sheetXml, newSheetNum);

    // 5) If the target already has a COVER_SHEET tab, replace it.
    await removeExistingSheet(out, COVER_TAB_NAME);

    // 6) Write the new worksheet part.
    out.file(newSheetFile, sheetXml);

    // 7) Register the sheet at the front of the tab list.
    await registerSheet(out, newSheetNum, COVER_TAB_NAME);

    // 8) Drop calcChain so Excel rebuilds it (sheet order changed).
    await dropCalcChain(out);

    return await out.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      compression: 'DEFLATE'
    });
  }

  // --- small helpers --------------------------------------------------------
  async function readStr(zip, path) {
    const f = zip.file(path);
    return f ? await f.async('string') : '';
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function escapeXmlAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }
  function matchSheetByName(wbXml, name) {
    const re = new RegExp('<sheet\\b[^>]*name="' + escapeRegex(name) + '"[^>]*/>', 'i');
    const m = wbXml.match(re);
    return m ? m[0] : null;
  }
  function relTarget(relsXml, rid) {
    if (!rid || !relsXml) return null;
    const m = relsXml.match(new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*Target="([^"]+)"'))
           || relsXml.match(new RegExp('<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="' + rid + '"'));
    return m ? m[1] : null;
  }
  // workbook.xml.rels targets are relative to xl/.
  function resolveXlPath(target) {
    let t = target.replace(/^\//, '');
    if (t.startsWith('xl/')) return t;
    return 'xl/' + t.replace(/^\.\.\//, '');
  }
  // Resolve a relative target against a base directory (handles ../).
  function normaliseRel(baseDir, target) {
    let t = target.replace(/^\//, '');
    if (t.startsWith('xl/')) return t;
    const stack = baseDir.replace(/\/$/, '').split('/');
    for (const p of t.split('/')) {
      if (p === '..') stack.pop();
      else if (p !== '.') stack.push(p);
    }
    return stack.join('/');
  }

  // --- shared strings -> inline ---------------------------------------------
  async function readSharedStrings(zip) {
    const xml = await readStr(zip, 'xl/sharedStrings.xml');
    if (!xml) return [];
    const arr = [];
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
      let text = '';
      const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(m[1]))) text += tm[1];
      arr.push(text);
    }
    return arr;
  }
  function inlineSharedStrings(sheetXml, sst) {
    return sheetXml.replace(/<c\b([^>]*?)\bt="s"([^>]*)>([\s\S]*?)<\/c>/g, (full, pre, post, inner) => {
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      const idx = vm ? parseInt(vm[1], 10) : -1;
      const text = (idx >= 0 && idx < sst.length) ? sst[idx] : '';
      return '<c' + pre + ' t="inlineStr"' + post + '><is><t xml:space="preserve">' + text + '</t></is></c>';
    });
  }

  // --- styles merge + remap -------------------------------------------------
  function listItems(xml, container, child) {
    const m = xml.match(new RegExp('<' + container + '\\b[^>]*>([\\s\\S]*?)<\\/' + container + '>'));
    if (!m) return [];
    const items = [];
    const re = new RegExp('<' + child + '\\b[^>]*?(?:/>|>[\\s\\S]*?<\\/' + child + '>)', 'g');
    let cm;
    while ((cm = re.exec(m[1]))) items.push(cm[0]);
    return items;
  }
  function countChildren(inner, child) {
    return (inner.match(new RegExp('<' + child + '\\b', 'g')) || []).length;
  }
  function appendToList(xml, container, child, items) {
    if (!items || items.length === 0) return xml;
    const appended = items.join('');
    const secRe = new RegExp('(<' + container + '\\b[^>]*>)([\\s\\S]*?)(<\\/' + container + '>)');
    const m = xml.match(secRe);
    if (m) {
      const existing = countChildren(m[2], child);
      const openTag = m[1].replace(/\scount="\d+"/, '').replace(/>$/, ' count="' + (existing + items.length) + '">');
      return xml.replace(secRe, () => openTag + m[2] + appended + m[3]);
    }
    const selfRe = new RegExp('<' + container + '\\b[^>]*/>');
    const newSection = '<' + container + ' count="' + items.length + '">' + appended + '</' + container + '>';
    if (selfRe.test(xml)) return xml.replace(selfRe, () => newSection);
    // Missing entirely — numFmts must be the first child of <styleSheet>.
    if (container === 'numFmts') return xml.replace(/(<styleSheet\b[^>]*>)/, (mm, p1) => p1 + newSection);
    return xml.replace(/<\/styleSheet>/, () => newSection + '</styleSheet>');
  }
  function remapSheetStyleIndices(xml, xfOffset, dxfOffset) {
    if (xfOffset) {
      xml = xml.replace(/(<c\b[^>]*?\bs=")(\d+)(")/g, (mm, a, n, b) => a + (parseInt(n, 10) + xfOffset) + b);
      xml = xml.replace(/(<col\b[^>]*?\bstyle=")(\d+)(")/g, (mm, a, n, b) => a + (parseInt(n, 10) + xfOffset) + b);
      xml = xml.replace(/(<row\b[^>]*?\bs=")(\d+)(")/g, (mm, a, n, b) => a + (parseInt(n, 10) + xfOffset) + b);
    }
    if (dxfOffset) {
      xml = xml.replace(/(dxfId=")(\d+)(")/g, (mm, a, n, b) => a + (parseInt(n, 10) + dxfOffset) + b);
    }
    return xml;
  }
  async function mergeStylesAndRemap(coverZip, out, sheetXml) {
    const coverStyles = await readStr(coverZip, 'xl/styles.xml');
    let targetStyles = await readStr(out, 'xl/styles.xml');
    if (!coverStyles) return sheetXml;
    if (!targetStyles) { out.file('xl/styles.xml', coverStyles); return sheetXml; }

    const cFonts = listItems(coverStyles, 'fonts', 'font');
    const cFills = listItems(coverStyles, 'fills', 'fill');
    const cBorders = listItems(coverStyles, 'borders', 'border');
    const cCellStyleXfs = listItems(coverStyles, 'cellStyleXfs', 'xf');
    const cCellXfs = listItems(coverStyles, 'cellXfs', 'xf');
    const cDxfs = listItems(coverStyles, 'dxfs', 'dxf');
    const cNumFmts = listItems(coverStyles, 'numFmts', 'numFmt');

    const fontOffset = listItems(targetStyles, 'fonts', 'font').length;
    const fillOffset = listItems(targetStyles, 'fills', 'fill').length;
    const borderOffset = listItems(targetStyles, 'borders', 'border').length;
    const cellStyleOffset = listItems(targetStyles, 'cellStyleXfs', 'xf').length;
    const xfOffset = listItems(targetStyles, 'cellXfs', 'xf').length;
    const dxfOffset = listItems(targetStyles, 'dxfs', 'dxf').length;

    // Custom number formats (id >= 164) need fresh, non-colliding ids.
    let nextNumFmtId = 164;
    for (const nf of listItems(targetStyles, 'numFmts', 'numFmt')) {
      const id = parseInt((nf.match(/numFmtId="(\d+)"/) || [])[1], 10);
      if (!isNaN(id) && id >= nextNumFmtId) nextNumFmtId = id + 1;
    }
    const numFmtMap = new Map();
    const newNumFmtItems = [];
    for (const nf of cNumFmts) {
      const id = parseInt((nf.match(/numFmtId="(\d+)"/) || [])[1], 10);
      if (isNaN(id)) continue;
      if (id < 164) { numFmtMap.set(id, id); continue; }
      const newId = nextNumFmtId++;
      numFmtMap.set(id, newId);
      newNumFmtItems.push(nf.replace(/numFmtId="\d+"/, 'numFmtId="' + newId + '"'));
    }

    const remapXf = (xf) => xf
      .replace(/fontId="(\d+)"/, (mm, n) => 'fontId="' + (parseInt(n, 10) + fontOffset) + '"')
      .replace(/fillId="(\d+)"/, (mm, n) => 'fillId="' + (parseInt(n, 10) + fillOffset) + '"')
      .replace(/borderId="(\d+)"/, (mm, n) => 'borderId="' + (parseInt(n, 10) + borderOffset) + '"')
      .replace(/numFmtId="(\d+)"/, (mm, n) => {
        const id = parseInt(n, 10);
        return 'numFmtId="' + (numFmtMap.has(id) ? numFmtMap.get(id) : id) + '"';
      });
    const remapCellXf = (xf) => remapXf(xf)
      .replace(/xfId="(\d+)"/, (mm, n) => 'xfId="' + (parseInt(n, 10) + cellStyleOffset) + '"');

    targetStyles = appendToList(targetStyles, 'numFmts', 'numFmt', newNumFmtItems);
    targetStyles = appendToList(targetStyles, 'fonts', 'font', cFonts);
    targetStyles = appendToList(targetStyles, 'fills', 'fill', cFills);
    targetStyles = appendToList(targetStyles, 'borders', 'border', cBorders);
    targetStyles = appendToList(targetStyles, 'cellStyleXfs', 'xf', cCellStyleXfs.map(remapXf));
    targetStyles = appendToList(targetStyles, 'cellXfs', 'xf', cCellXfs.map(remapCellXf));
    if (cDxfs.length) targetStyles = appendToList(targetStyles, 'dxfs', 'dxf', cDxfs);

    out.file('xl/styles.xml', targetStyles);
    return remapSheetStyleIndices(sheetXml, xfOffset, dxfOffset);
  }

  // --- drawing / logo image -------------------------------------------------
  function nextSheetNumber(out) {
    let max = 0;
    for (const p of Object.keys(out.files)) {
      const m = p.match(/^xl\/worksheets\/sheet(\d+)\.xml$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }
  function nextDrawingNumber(out) {
    let max = 0;
    for (const p of Object.keys(out.files)) {
      const m = p.match(/^xl\/drawings\/drawing(\d+)\.xml$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }
  function uniqueXlsxMediaName(out, filename) {
    if (!out.file('xl/media/' + filename)) return filename;
    const dot = filename.lastIndexOf('.');
    const base = dot >= 0 ? filename.slice(0, dot) : filename;
    const ext = dot >= 0 ? filename.slice(dot) : '';
    let i = 1, cand;
    do { cand = base + '_cover' + i + ext; i++; } while (out.file('xl/media/' + cand));
    return cand;
  }
  async function carryDrawing(coverZip, out, coverSheetPath, sheetXml, newSheetNum) {
    const drawingEl = sheetXml.match(/<drawing\b[^>]*r:id="([^"]+)"[^>]*\/>/);
    if (!drawingEl) return sheetXml;
    const drawingRid = drawingEl[1];

    const sheetFileName = coverSheetPath.split('/').pop();
    const coverSheetRels = await readStr(coverZip, 'xl/worksheets/_rels/' + sheetFileName + '.rels');
    const drawingTarget = relTarget(coverSheetRels, drawingRid);
    if (!drawingTarget) return sheetXml.replace(drawingEl[0], '');

    const drawingPath = normaliseRel('xl/worksheets/', drawingTarget);
    const drawingXml = await readStr(coverZip, drawingPath);
    if (!drawingXml) return sheetXml.replace(drawingEl[0], '');

    const drawingFileName = drawingPath.split('/').pop();
    let drawingRels = await readStr(coverZip, 'xl/drawings/_rels/' + drawingFileName + '.rels');

    // Copy referenced media, renaming on collision, and rewrite the rel targets.
    const mediaExts = new Set();
    if (drawingRels) {
      const relRe = /<Relationship\b[^>]*\/>/g;
      const replacements = [];
      let rm;
      while ((rm = relRe.exec(drawingRels))) {
        const relStr = rm[0];
        const tgt = (relStr.match(/Target="([^"]+)"/) || [])[1];
        const mode = (relStr.match(/TargetMode="([^"]+)"/) || [])[1];
        if (!tgt || (mode && mode.toLowerCase() === 'external')) continue;
        if (!/media\//i.test(tgt)) continue;
        const mediaPath = normaliseRel('xl/drawings/', tgt);
        const srcFile = coverZip.file(mediaPath);
        if (!srcFile) continue;
        const uniqueName = uniqueXlsxMediaName(out, mediaPath.split('/').pop());
        out.file('xl/media/' + uniqueName, await srcFile.async('uint8array'));
        const ext = (uniqueName.match(/\.([^.]+)$/) || [])[1];
        if (ext) mediaExts.add(ext.toLowerCase());
        replacements.push([tgt, '../media/' + uniqueName]);
      }
      for (const [oldT, newT] of replacements) {
        drawingRels = drawingRels.split('Target="' + oldT + '"').join('Target="' + newT + '"');
      }
    }

    const newDrawingNum = nextDrawingNumber(out);
    out.file('xl/drawings/drawing' + newDrawingNum + '.xml', drawingXml);
    if (drawingRels) out.file('xl/drawings/_rels/drawing' + newDrawingNum + '.xml.rels', drawingRels);

    const newSheetRid = 'rId1';
    out.file('xl/worksheets/_rels/sheet' + newSheetNum + '.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="' + newSheetRid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing' + newDrawingNum + '.xml"/>' +
      '</Relationships>');

    sheetXml = sheetXml.replace(drawingEl[0], '<drawing r:id="' + newSheetRid + '"/>');
    await addDrawingContentTypes(out, 'xl/drawings/drawing' + newDrawingNum + '.xml', mediaExts);
    return sheetXml;
  }
  async function addDrawingContentTypes(out, drawingFile, mediaExts) {
    let ct = await readStr(out, '[Content_Types].xml');
    if (!ct) return;
    const partName = '/' + drawingFile;
    if (ct.indexOf('PartName="' + partName + '"') === -1) {
      const ov = '<Override PartName="' + partName + '" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>';
      ct = ct.replace(/<\/Types>\s*$/, () => ov + '</Types>');
    }
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/x-emf',
      wmf: 'image/x-wmf', svg: 'image/svg+xml', webp: 'image/webp'
    };
    for (const ext of mediaExts) {
      if (new RegExp('<Default\\b[^>]*Extension="' + ext + '"', 'i').test(ct)) continue;
      const tag = '<Default Extension="' + ext + '" ContentType="' + (mime[ext] || 'application/octet-stream') + '"/>';
      if (/<Override\b/.test(ct)) ct = ct.replace(/<Override\b/, () => tag + '<Override');
      else ct = ct.replace(/<\/Types>\s*$/, () => tag + '</Types>');
    }
    out.file('[Content_Types].xml', ct);
  }

  // --- workbook registration / cleanup --------------------------------------
  async function removeExistingSheet(out, name) {
    let wbXml = await readStr(out, 'xl/workbook.xml');
    const el = matchSheetByName(wbXml, name);
    if (!el) return;
    const rid = (el.match(/r:id="([^"]+)"/) || [])[1];
    out.file('xl/workbook.xml', wbXml.replace(el, ''));

    let rels = await readStr(out, 'xl/_rels/workbook.xml.rels');
    const tgt = relTarget(rels, rid);
    if (!tgt) return;
    rels = rels.replace(new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*/>'), '');
    out.file('xl/_rels/workbook.xml.rels', rels);

    const partPath = resolveXlPath(tgt);
    out.remove(partPath);
    let ct = await readStr(out, '[Content_Types].xml');
    ct = ct.replace(new RegExp('<Override\\b[^>]*PartName="/' + escapeRegex(partPath) + '"[^>]*/>'), '');
    out.file('[Content_Types].xml', ct);
    out.remove('xl/worksheets/_rels/' + partPath.split('/').pop() + '.rels');
  }
  async function registerSheet(out, newSheetNum, name) {
    const target = 'worksheets/sheet' + newSheetNum + '.xml';

    let rels = await readStr(out, 'xl/_rels/workbook.xml.rels');
    let maxRid = 0;
    for (const m of rels.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, parseInt(m[1], 10));
    const newRid = 'rId' + (maxRid + 1);
    const relEl = '<Relationship Id="' + newRid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="' + target + '"/>';
    rels = rels.replace(/<\/Relationships>\s*$/, () => relEl + '</Relationships>');
    out.file('xl/_rels/workbook.xml.rels', rels);

    let wb = await readStr(out, 'xl/workbook.xml');
    let maxSheetId = 0;
    for (const m of wb.matchAll(/sheetId="(\d+)"/g)) maxSheetId = Math.max(maxSheetId, parseInt(m[1], 10));
    // Declare xmlns:r on the element itself: some producers (e.g. openpyxl)
    // declare the relationships namespace per-<sheet> rather than on the root
    // <workbook>, so a bare r:id here would be an undefined-prefix error. This
    // is redundant-but-valid when the root already declares it (real Excel).
    const sheetEl = '<sheet name="' + escapeXmlAttr(name) + '" sheetId="' + (maxSheetId + 1) +
      '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="' + newRid + '"/>';
    wb = wb.replace(/(<sheets\b[^>]*>)/, (mm, p1) => p1 + sheetEl);
    if (/<workbookView\b/.test(wb)) {
      wb = /activeTab="\d+"/.test(wb)
        ? wb.replace(/activeTab="\d+"/, 'activeTab="0"')
        : wb.replace(/<workbookView\b/, '<workbookView activeTab="0"');
    }
    out.file('xl/workbook.xml', wb);

    let ct = await readStr(out, '[Content_Types].xml');
    const partName = '/xl/worksheets/sheet' + newSheetNum + '.xml';
    if (ct.indexOf('PartName="' + partName + '"') === -1) {
      const ov = '<Override PartName="' + partName + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      ct = ct.replace(/<\/Types>\s*$/, () => ov + '</Types>');
      out.file('[Content_Types].xml', ct);
    }
  }
  async function dropCalcChain(out) {
    if (!out.file('xl/calcChain.xml')) return;
    out.remove('xl/calcChain.xml');
    let ct = await readStr(out, '[Content_Types].xml');
    out.file('[Content_Types].xml', ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
    let rels = await readStr(out, 'xl/_rels/workbook.xml.rels');
    out.file('xl/_rels/workbook.xml.rels', rels.replace(/<Relationship\b[^>]*Target="calcChain\.xml"[^>]*\/>/, ''));
  }
  // =====================================================================
  // PPTX merge engine — copy the cover deck's FIRST slide (with its full
  // design set: layouts, master, theme, media) into the target deck as the
  // first slide. The target's existing parts are left byte-identical; we add
  // new parts under fresh names, renumber presentation-wide IDs to avoid
  // collisions, and register the new master + slide in presentation.xml.
  // Reuses readStr / normaliseRel / escapeRegex / relTarget from above.
  // =====================================================================
  function pptxRelsPathFor(p) {
    const i = p.lastIndexOf('/');
    return p.slice(0, i) + '/_rels/' + p.slice(i + 1) + '.rels';
  }
  function pptxDir(p) { return p.slice(0, p.lastIndexOf('/')); }
  function pptxBase(p) { return p.slice(p.lastIndexOf('/') + 1); }
  function pptxParseRels(relsXml) {
    const out = [];
    const re = /<Relationship\b[^>]*\/>/g;
    let m;
    while ((m = re.exec(relsXml))) {
      const s = m[0];
      out.push({
        id: (s.match(/Id="([^"]+)"/) || [])[1],
        target: (s.match(/Target="([^"]+)"/) || [])[1],
        mode: (s.match(/TargetMode="([^"]+)"/) || [])[1],
      });
    }
    return out;
  }
  // Relative path from a directory to a part path (both absolute within the zip).
  function pptxRelPath(fromDir, toPath) {
    const from = fromDir.replace(/\/$/, '').split('/');
    const to = toPath.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    const rel = [];
    for (let k = i; k < from.length; k++) rel.push('..');
    for (let k = i; k < to.length; k++) rel.push(to[k]);
    return rel.join('/');
  }
  function pptxNextNum(out, dir, prefix) {
    let max = 0;
    const re = new RegExp('^' + escapeRegex(dir) + '/' + escapeRegex(prefix) + '(\\d+)\\.[^.]+$');
    for (const p of Object.keys(out.files)) { const m = p.match(re); if (m) max = Math.max(max, parseInt(m[1], 10)); }
    return max + 1;
  }
  function pptxUniqueMedia(out, filename) {
    if (!out.file('ppt/media/' + filename)) return filename;
    const dot = filename.lastIndexOf('.');
    const base = dot >= 0 ? filename.slice(0, dot) : filename;
    const ext = dot >= 0 ? filename.slice(dot) : '';
    let i = 1, cand;
    do { cand = base + '_cover' + i + ext; i++; } while (out.file('ppt/media/' + cand));
    return cand;
  }
  // BFS the relationship graph from a starting part, collecting all internal
  // parts it (transitively) depends on.
  async function pptxClosure(zip, startPath) {
    const seen = new Set();
    const queue = [startPath];
    while (queue.length) {
      const part = queue.shift();
      if (seen.has(part)) continue;
      seen.add(part);
      const relsXml = await readStr(zip, pptxRelsPathFor(part));
      if (!relsXml) continue;
      const baseDir = pptxDir(part) + '/';
      for (const r of pptxParseRels(relsXml)) {
        if (!r.target || (r.mode && r.mode.toLowerCase() === 'external')) continue;
        const abs = normaliseRel(baseDir, r.target);
        if (!seen.has(abs)) queue.push(abs);
      }
    }
    return seen;
  }

  async function mergePptx(coverFile, targetFile) {
    const coverZip = await JSZip.loadAsync(coverFile);
    const targetZip = await JSZip.loadAsync(targetFile);

    const out = new JSZip();
    for (const path of Object.keys(targetZip.files)) {
      if (targetZip.files[path].dir) continue;
      out.file(path, await targetZip.files[path].async('uint8array'));
    }

    // 1) Find the cover's first slide.
    const coverPresXml = await readStr(coverZip, 'ppt/presentation.xml');
    const coverPresRels = await readStr(coverZip, 'ppt/_rels/presentation.xml.rels');
    const firstSld = coverPresXml.match(/<p:sldIdLst>[\s\S]*?<p:sldId\b[^>]*r:id="([^"]+)"/);
    if (!firstSld) throw new Error('The cover presentation has no slides.');
    const slideTarget = relTarget(coverPresRels, firstSld[1]);
    if (!slideTarget) throw new Error('Could not resolve the cover slide.');
    const startSlidePath = normaliseRel('ppt/', slideTarget);

    // 2) Collect the slide's full reachable part-set.
    const closure = await pptxClosure(coverZip, startSlidePath);

    // 3) Assign fresh filenames in the target for every collected part.
    let nSlide = pptxNextNum(out, 'ppt/slides', 'slide');
    let nLayout = pptxNextNum(out, 'ppt/slideLayouts', 'slideLayout');
    let nMaster = pptxNextNum(out, 'ppt/slideMasters', 'slideMaster');
    let nTheme = pptxNextNum(out, 'ppt/theme', 'theme');
    const rename = new Map();
    let newSlidePath = null, newMasterPath = null;
    const newLayoutPaths = [], newThemePaths = [];
    for (const part of closure) {
      let np;
      if (/^ppt\/slides\/slide\d+\.xml$/.test(part)) { np = 'ppt/slides/slide' + (nSlide++) + '.xml'; newSlidePath = np; }
      else if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(part)) { np = 'ppt/slideLayouts/slideLayout' + (nLayout++) + '.xml'; newLayoutPaths.push(np); }
      else if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(part)) { np = 'ppt/slideMasters/slideMaster' + (nMaster++) + '.xml'; newMasterPath = np; }
      else if (/^ppt\/theme\/theme\d+\.xml$/.test(part)) { np = 'ppt/theme/theme' + (nTheme++) + '.xml'; newThemePaths.push(np); }
      else if (/^ppt\/media\//.test(part)) { np = 'ppt/media/' + pptxUniqueMedia(out, pptxBase(part)); }
      else { np = pptxDir(part) + '/cover_' + pptxBase(part); }
      rename.set(part, np);
    }
    if (!newSlidePath || !newMasterPath) throw new Error('Cover slide is missing its slide or master part.');

    // 4) Copy each part verbatim under its new name.
    for (const [oldP, newP] of rename) {
      const f = coverZip.file(oldP);
      if (!f) continue;
      if (/\.(xml|rels)$/i.test(oldP)) out.file(newP, await f.async('string'));
      else out.file(newP, await f.async('uint8array'));
    }

    // 5) Recreate each copied part's rels, repointing Targets to the new names.
    for (const [oldP, newP] of rename) {
      const relsXml = await readStr(coverZip, pptxRelsPathFor(oldP));
      if (!relsXml) continue;
      const oldBaseDir = pptxDir(oldP) + '/';
      const newBaseDir = pptxDir(newP) + '/';
      let rewritten = relsXml;
      for (const r of pptxParseRels(relsXml)) {
        if (!r.target || (r.mode && r.mode.toLowerCase() === 'external')) continue;
        const abs = normaliseRel(oldBaseDir, r.target);
        if (rename.has(abs)) {
          const newRel = pptxRelPath(newBaseDir, rename.get(abs));
          rewritten = rewritten.split('Target="' + r.target + '"').join('Target="' + newRel + '"');
        }
      }
      out.file(pptxRelsPathFor(newP), rewritten);
    }

    // 6) Renumber IDs so they don't collide with the target. Slide-master IDs
    //    and slide-layout IDs share ONE id space in PowerPoint — every master
    //    id and every layout id must be unique relative to each other or the
    //    file is rejected as corrupt. So allocate the new master id and the new
    //    layout ids from a single counter above the global max of both.
    let presXml = await readStr(out, 'ppt/presentation.xml');
    let maxSldId = 255, maxMLId = 2147483647;
    for (const m of presXml.matchAll(/<p:sldId\b[^>]*\bid="(\d+)"/g)) maxSldId = Math.max(maxSldId, +m[1]);
    for (const m of presXml.matchAll(/<p:sldMasterId\b[^>]*\bid="(\d+)"/g)) maxMLId = Math.max(maxMLId, +m[1]);
    for (const p of Object.keys(out.files)) {
      if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p) && p !== newMasterPath) {
        const x = await readStr(out, p);
        for (const m of x.matchAll(/<p:sldLayoutId\b[^>]*\bid="(\d+)"/g)) maxMLId = Math.max(maxMLId, +m[1]);
      }
    }
    const newMasterPresId = maxMLId + 1;
    // Renumber the new master's layout ids above the new master id.
    let masterXml = await readStr(out, newMasterPath);
    let nextLayoutId = maxMLId + 2;
    masterXml = masterXml.replace(/(<p:sldLayoutId\b[^>]*\bid=")(\d+)(")/g, (mm, a, n, b) => a + (nextLayoutId++) + b);
    out.file(newMasterPath, masterXml);
    const newSlidePresId = maxSldId + 1;

    // 7) presentation.xml.rels — relationships for the new master + slide.
    let presRels = await readStr(out, 'ppt/_rels/presentation.xml.rels');
    let maxRid = 0;
    for (const m of presRels.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, +m[1]);
    const relMaster = 'rId' + (maxRid + 1), relSlide = 'rId' + (maxRid + 2);
    const masterRel = '<Relationship Id="' + relMaster + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="' + newMasterPath.replace(/^ppt\//, '') + '"/>';
    const slideRel = '<Relationship Id="' + relSlide + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="' + newSlidePath.replace(/^ppt\//, '') + '"/>';
    presRels = presRels.replace(/<\/Relationships>\s*$/, () => masterRel + slideRel + '</Relationships>');
    out.file('ppt/_rels/presentation.xml.rels', presRels);

    // 8) presentation.xml — append master, insert slide at the FRONT.
    const masterEntry = '<p:sldMasterId id="' + newMasterPresId + '" r:id="' + relMaster + '"/>';
    presXml = presXml.replace(/<\/p:sldMasterIdLst>/, () => masterEntry + '</p:sldMasterIdLst>');
    const slideEntry = '<p:sldId id="' + newSlidePresId + '" r:id="' + relSlide + '"/>';
    if (/<p:sldIdLst>/.test(presXml)) presXml = presXml.replace(/<p:sldIdLst>/, (m) => m + slideEntry);
    else if (/<p:sldIdLst\s*\/>/.test(presXml)) presXml = presXml.replace(/<p:sldIdLst\s*\/>/, '<p:sldIdLst>' + slideEntry + '</p:sldIdLst>');
    else presXml = presXml.replace(/<\/p:sldMasterIdLst>/, () => '</p:sldMasterIdLst><p:sldIdLst>' + slideEntry + '</p:sldIdLst>');
    out.file('ppt/presentation.xml', presXml);

    // 9) [Content_Types].xml — overrides for the new parts + media defaults.
    let ct = await readStr(out, '[Content_Types].xml');
    const ov = (path, type) => '<Override PartName="/' + path + '" ContentType="' + type + '"/>';
    const overrides = [
      ov(newSlidePath, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'),
      ov(newMasterPath, 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'),
    ];
    for (const lp of newLayoutPaths) overrides.push(ov(lp, 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'));
    for (const tp of newThemePaths) overrides.push(ov(tp, 'application/vnd.openxmlformats-officedocument.theme+xml'));
    let add = '';
    for (const o of overrides) {
      const pn = o.match(/PartName="([^"]+)"/)[1];
      if (ct.indexOf('PartName="' + pn + '"') === -1) add += o;
    }
    if (add) ct = ct.replace(/<\/Types>\s*$/, () => add + '</Types>');
    for (const [ext, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['jpg', 'image/jpeg'], ['gif', 'image/gif'], ['emf', 'image/x-emf'], ['wmf', 'image/x-wmf']]) {
      // only add a Default for extensions we actually brought in
      const used = Array.from(rename.values()).some(p => p.toLowerCase().endsWith('.' + ext));
      if (!used) continue;
      if (new RegExp('<Default\\b[^>]*Extension="' + ext + '"', 'i').test(ct)) continue;
      const tag = '<Default Extension="' + ext + '" ContentType="' + mime + '"/>';
      ct = /<Override\b/.test(ct) ? ct.replace(/<Override\b/, tag + '<Override') : ct.replace(/<\/Types>\s*$/, () => tag + '</Types>');
    }
    out.file('[Content_Types].xml', ct);

    return await out.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      compression: 'DEFLATE'
    });
  }
})();
