
  
  async function getUserDetailsFill() {
    await getUserDetails();
    access_token = await getAccessToken("account:read data:read");
    userID = userDetails.sub;
    sessionStorage.setItem('userDetails',userDetails)
    sessionStorage.setItem('userID',userID)
    //console.log("userID",sessionStorage.getItem('userID'))
    setUserInfo(userDetails);

    const profileMenu = document.getElementById('profileMenu');
    const dropdown = document.getElementById('dropdown');

    profileMenu.addEventListener('click', (e) => {
        dropdown.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
        if (!profileMenu.contains(e.target)) {
        dropdown.classList.remove('active');
        }
    });
  }

  function logout() {
    localStorage.setItem("user_refresh_token", "blank");
    clearUrlParameters();
    signin();
  }

  async function setUserInfo(data) {
    const profilePic = document.getElementById("userPic");
    const profileName = document.getElementById("userName");
    const profileEmail = document.getElementById("userEmail");
    if (data.picture) {
      profilePic.src = data.picture;
    } else {
      console.error("Image URL is undefined");
    }
    profileName.textContent = data.name;
    profileEmail.textContent = data.email;
  }
  function showCustomAlert() {
    document.getElementById('custom-alert').style.display = 'flex';
    document.getElementById('AAFLink').href = AAFLink;
  }

  async function getUserDetails() {
    const headers = {
      "Content-Type": "application/json",
      Authorization: userAccessToken, // Make sure this is securely handled
    };
    const requestOptions = {
      method: "GET",
      headers: headers,
    };
    const apiUrl = "https://api.userprofile.autodesk.com/userinfo";
    response = await fetch(apiUrl, requestOptions)
      .then((response) => response.json())
      .then((data) => {
        //console.log(data);
        userDetails = data;
        return data;
      })
      .catch((error) => console.error("Error fetching data:", error));
    return response;
  }

  // PKCE helpers (RFC 7636). The verifier is a high-entropy random string
  // kept in sessionStorage across the OAuth redirect; the challenge is its
  // SHA-256 hash sent to /authorize. At /token the same verifier is
  // submitted, proving the same browser session is redeeming the code —
  // no shared client secret needed.
  function _pkceBase64Url(bytes) {
    let str = "";
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  function generateCodeVerifier() {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    return _pkceBase64Url(bytes);
  }
  async function generateCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return _pkceBase64Url(new Uint8Array(hash));
  }

  async function signin() {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    // Random per-flow state. Autodesk echoes it back on redirect; we verify
    // it matches what we sent before redeeming the code, which prevents an
    // attacker from tricking a logged-in user into redeeming an attacker-
    // controlled `?code=` (CSRF). Reuses the same base64url encoding as the
    // PKCE verifier helper.
    const stateBytes = new Uint8Array(16);
    crypto.getRandomValues(stateBytes);
    const state = _pkceBase64Url(stateBytes);

    sessionStorage.setItem("pkce_verifier", verifier);
    sessionStorage.setItem("oauth_state", state);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: apsClientId,
      redirect_uri: toolURL,
      scope: "data:read data:write data:create",
      prompt: "login",
      state: state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    window.open(
      "https://developer.api.autodesk.com/authentication/v2/authorize?" + params.toString(),
      "_self"
    );
  }
  async function checkLogin() {
    var codeParam = getParameterByName("code");
    var stateParam = getParameterByName("state");
    var localRefreshToken = localStorage.getItem("user_refresh_token");

    if (codeParam !== null) {
      // Returning from /authorize with a one-time code — always prefer
      // redeeming this over attempting a refresh. A redirect with a fresh
      // code typically means the user just (re-)logged in, in which case
      // any existing refresh_token has been superseded or invalidated.
      const expectedState = sessionStorage.getItem("oauth_state");
      if (!expectedState || stateParam !== expectedState) {
        // State mismatch = CSRF attempt or browser state lost between
        // authorize and redirect. Refuse to redeem and restart cleanly.
        console.warn("OAuth state mismatch — refusing to redeem code and restarting login.");
        sessionStorage.removeItem("oauth_state");
        sessionStorage.removeItem("pkce_verifier");
        clearUrlParameters();
        await signin();
        return;
      }
      sessionStorage.removeItem("oauth_state");
      await getAuthorisation(codeParam);
    } else if (localRefreshToken && localRefreshToken !== "blank") {
      // Have a stored refresh token from a previous session — try silent refresh.
      // Awaited so loginReady doesn't resolve until the token + user details
      // round-trip is complete. Without the await, gatherArrays() would race
      // ahead and fetch the project list with an unset userID.
      await refreshToken();
    } else {
      // No session and no code in URL — kick off the OAuth redirect.
      await signin();
    }
  }
  // Function to parse URL parameters
  function getParameterByName(name, url) {
    if (!url) url = window.location.href;
    name = name.replace(/[\[\]]/g, "\\$&");
    var regex = new RegExp("[?&]" + name + "(=([^&#]*)|&|#|$)"),
      results = regex.exec(url);
    if (!results) return null;
    if (!results[2]) return "";
    return decodeURIComponent(results[2].replace(/\+/g, " "));
  }
  
  // Function to clear URL parameters (after reload or after successful fetch)
  function clearUrlParameters() {
    // Replace the current URL without reloading the page, and remove query parameters
    const cleanUrl =
      window.location.protocol +
      "//" +
      window.location.host +
      window.location.pathname;
    window.history.replaceState({ path: cleanUrl }, "", cleanUrl);
  }
  
  async function getAuthorisation(code) {
    const verifier = sessionStorage.getItem("pkce_verifier");
    if (!verifier) {
      // Verifier was lost (cleared sessionStorage, opened in new tab, etc.).
      // The /token call would fail anyway — restart the OAuth flow.
      console.error("PKCE verifier missing — restarting login.");
      await signin();
      return;
    }

    const bodyData = {
      grant_type: "authorization_code",
      code: code,
      redirect_uri: toolURL,
      client_id: apsClientId,
      code_verifier: verifier,
    };

    const formBody = Object.keys(bodyData)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(bodyData[k])}`)
      .join("&");

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      // No Authorization header — PKCE clients authenticate via client_id +
      // code_verifier in the request body, not a Basic auth secret.
    };

    const requestOptions = {
      method: "POST",
      headers: headers,
      body: formBody,
    };

    const apiUrl = "https://developer.api.autodesk.com/authentication/v2/token";
    AccessToken_Local = await fetch(apiUrl, requestOptions)
      .then(async (response) => {
        if (!response.ok) {
          // /token rejected the code — bad/replayed/expired code, wrong PKCE
          // verifier, or wrong client_id. Wipe state and restart fresh login.
          console.warn("Auth code exchange failed with HTTP " + response.status);
          sessionStorage.removeItem("pkce_verifier");
          localStorage.setItem("user_refresh_token", "blank");
          clearUrlParameters();
          location.reload();
          throw new Error("Auth code exchange failed; reloading.");
        }
        return response.json();
      })
      .then(async (data) => {
        userRefreshToken = data.refresh_token;
        localStorage.setItem("user_refresh_token", userRefreshToken);
        userAccessToken = data.access_token;
        // Verifier is single-use; clear so a leaked code can't be replayed.
        sessionStorage.removeItem("pkce_verifier");
        await getUserDetailsFill();
        return data;
      })
      .catch((error) => console.error("Error fetching data:", error));
    return AccessToken_Local;
  }
  async function refreshToken() {
    const localRefreshToken = localStorage.getItem("user_refresh_token");

    const bodyData = {
      grant_type: "refresh_token",
      refresh_token: localRefreshToken,
      client_id: apsClientId,
      redirect_uri: toolURL,
    };
    const formBody = Object.keys(bodyData)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(bodyData[key])}`)
      .join("&");

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      // No Authorization header — PKCE clients send client_id in the body
      // and don't have a shared secret to put here.
    };
  
    const requestOptions = {
      method: "POST",
      headers: headers,
      body: formBody,
    };
  
    const apiUrl = "https://developer.api.autodesk.com/authentication/v2/token";
    //console.log(apiUrl, requestOptions)
    AccessToken_Local = await fetch(apiUrl, requestOptions)
      .then(async (response) => {
        if (!response.ok) {
          // Refresh rejected — common causes: expired/revoked refresh token,
          // or (most likely after the PKCE migration) a token issued for the
          // previous confidential client_id. Wipe and force a fresh login.
          // 401 responses can have empty / non-JSON bodies, so we check
          // response.ok before trying to parse.
          console.warn("Token refresh failed with HTTP " + response.status + " — forcing fresh login.");
          localStorage.setItem("user_refresh_token", "blank");
          clearUrlParameters();
          location.reload();
          throw new Error("Token refresh failed; reloading.");
        }
        return response.json();
      })
      .then(async (data) => {
        localStorage.setItem("user_refresh_token", data.refresh_token);
        userRefreshToken = data.refresh_token;
        userAccessToken = data.access_token;
        // Wait for user details (incl. userID) to be in sessionStorage
        // before this promise resolves — gatherArrays() awaits the same
        // chain to know the project list fetch can safely run.
        await getUserDetailsFill();
        return data;
      })
      .catch((error) => console.error("Error fetching data:", error));
    return AccessToken_Local;
  }
  
  
  
  
  
  