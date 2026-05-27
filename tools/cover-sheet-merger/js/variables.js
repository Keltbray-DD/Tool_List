const appName = "Forma Cover Sheet Merger";
const appVersion = "v2.0.0";

// Supported document types. The cover file the user picks determines the
// workflow:
//   .docx — cover is prepended to a Word document (section break).
//   .xlsx — cover's COVER_SHEET tab is copied into a workbook as the first tab.
//   .pdf  — cover's first page is prepended to the front of a PDF.
//   .pptx — cover's first slide (with its design) is added as the first slide.
const SUPPORTED_EXTS = [".docx", ".xlsx", ".pdf", ".pptx"];
const COVER_TAB_NAME = "COVER_SHEET"; // Excel: tab copied from the cover workbook

// --- Autodesk APS config (shared with the TIDP uploader) --------------------
const hubID = "b.24d2d632-e01b-4ca0-b988-385be827cb04";
const account_id = "24d2d632-e01b-4ca0-b988-385be827cb04";
// PKCE public client ID. Safe to ship in the browser — PKCE replaces the
// client secret with a per-flow verifier/challenge pair.
const apsClientId = "rIZ4T6uq2qbVGsBucgGz8zwSPPrENzupOQGkO9ii01U4nNT0";

// Fixed folder convention. The cover-sheets folder is resolved by walking
// Project Files down this path. If it doesn't exist in a given project, the
// UI falls back to letting the user pick a cover sheet from their desktop.
const COVER_SHEETS_PATH = ["0B.GENERAL", "COVER_SHEETS"];

// --- Auth / session globals (read & written by login.js) --------------------
let toolURL;
let userDetails;
let userID;
let userAccessToken;   // 3-legged user token (login)
let userRefreshToken;
let AccessToken_Local;
let access_token;      // 2-legged token from the Power Automate proxy

// --- App state --------------------------------------------------------------
let projectID;
let projectName;
let ProjectList = [];
let ProjectListRaw;

// Resolves once login completed AND user details (incl. userID in
// sessionStorage) are populated. acc.js awaits this before fetching projects.
let resolveLoginReady;
const loginReady = new Promise(resolve => { resolveLoginReady = resolve; });

document.addEventListener('DOMContentLoaded', async function () {
    const info = document.getElementById('appInfo');
    if (info) info.textContent = `${appName} ${appVersion}`;

    // Redirect URI for the OAuth flow is this page minus any query string.
    toolURL = window.location.href.split('?')[0];

    try {
        await checkLogin();
    } finally {
        // Always signal — if login redirected the page is unloading anyway;
        // if it failed, downstream code can fail loudly rather than hang.
        resolveLoginReady();
    }
});

function signOut() {
    localStorage.setItem('user_refresh_token', 'blank');
    signin();
}
