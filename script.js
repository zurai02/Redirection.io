"use strict";
/* ============================================================
   Redirection — client-side link shortener
   Everything (accounts, links, click counts) lives in this
   browser's localStorage. There is no real server behind the
   short codes; redirects work by re-opening this same page
   with a #/r/CODE hash.
   ============================================================ */
(function () {
    "use strict";
    const DB_KEY = "redirection_db_v1";
    const SESSION_KEY = "redirection_session";
    function loadDB() {
        try {
            const raw = localStorage.getItem(DB_KEY);
            if (!raw)
                return { users: {}, links: {} };
            return JSON.parse(raw);
        }
        catch (_a) {
            return { users: {}, links: {} };
        }
    }
    function saveDB(database) {
        localStorage.setItem(DB_KEY, JSON.stringify(database));
    }
    let db = loadDB();
    function hash(str) {
        // simple non-cryptographic hash — this is a local demo, not a security layer
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        }
        return String(h);
    }
    function currentUser() {
        const email = sessionStorage.getItem(SESSION_KEY);
        return email && db.users[email] ? email : null;
    }
    function genCode() {
        const chars = "abcdefghijkmnpqrstuvwxyz23456789";
        let code = "";
        do {
            code = "";
            for (let i = 0; i < 6; i++) {
                code += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (db.links[code]);
        return code;
    }
    function normalizeUrl(url) {
        url = url.trim();
        if (!/^https?:\/\//i.test(url))
            url = "https://" + url;
        return url;
    }
    function escapeHtml(s) {
        const map = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        };
        return s.replace(/[&<>"']/g, (c) => map[c]);
    }
    function el(id) {
        const node = document.getElementById(id);
        if (!node)
            throw new Error(`Missing element #${id}`);
        return node;
    }
    /* ---------------------------- Toast ---------------------------- */
    let toastTimer;
    function toast(msg) {
        const node = el("toast");
        node.textContent = msg;
        node.classList.add("show");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => node.classList.remove("show"), 2200);
    }
    /* ------------------------ Redirect handling ---------------------- */
    function tryHandleRedirect() {
        const match = location.hash.match(/^#\/r\/(.+)$/);
        if (!match)
            return false;
        const code = decodeURIComponent(match[1]);
        const screen = el("redirectScreen");
        const label = el("redirectLabel");
        el("app").style.display = "none";
        screen.style.display = "flex";
        const link = db.links[code];
        if (!link) {
            label.innerHTML = `No route found for <span class="dest miss">/${escapeHtml(code)}</span>`;
            return true;
        }
        link.clicks = (link.clicks || 0) + 1;
        link.lastClicked = Date.now();
        saveDB(db);
        label.innerHTML = `Routing to <span class="dest">${escapeHtml(link.dest)}</span>`;
        window.setTimeout(() => {
            window.location.href = link.dest;
        }, 700);
        return true;
    }
    /* ----------------------------- Views ----------------------------- */
    const authView = el("authView");
    const dashView = el("dashView");
    const sessionInfo = el("sessionInfo");
    let authMode = "login";
    let lastCreated = null;
    function renderAuth() {
        dashView.style.display = "none";
        authView.style.display = "block";
        sessionInfo.innerHTML = "";
        authView.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-tabs">
            <button class="auth-tab ${authMode === "login" ? "active" : ""}" data-mode="login">Log in</button>
            <button class="auth-tab ${authMode === "signup" ? "active" : ""}" data-mode="signup">Create account</button>
          </div>
          <form id="authForm" novalidate>
            <div class="field">
              <label for="authEmail">Email</label>
              <input id="authEmail" type="email" autocomplete="username" placeholder="you@example.com" required>
            </div>
            <div class="field">
              <label for="authPass">Password</label>
              <input id="authPass" type="password" autocomplete="${authMode === "login" ? "current-password" : "new-password"}" placeholder="${authMode === "signup" ? "At least 6 characters" : "••••••••"}" required>
              <div class="err" id="authErr" style="display:none;"></div>
            </div>
            <button type="submit" class="btn-primary">${authMode === "login" ? "Log in" : "Create account"}</button>
          </form>
          <div class="auth-note">Accounts and links are stored only in this browser's local storage. Nothing is sent to a server.</div>
        </div>
      </div>
    `;
        authView.querySelectorAll(".auth-tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                authMode = tab.dataset.mode;
                renderAuth();
            });
        });
        const form = authView.querySelector("#authForm");
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const emailInput = authView.querySelector("#authEmail");
            const passInput = authView.querySelector("#authPass");
            const errEl = authView.querySelector("#authErr");
            const email = emailInput.value.trim().toLowerCase();
            const pass = passInput.value;
            errEl.style.display = "none";
            if (!email || !pass) {
                errEl.textContent = "Enter an email and password.";
                errEl.style.display = "block";
                return;
            }
            if (authMode === "signup") {
                if (db.users[email]) {
                    errEl.textContent = "An account with that email already exists.";
                    errEl.style.display = "block";
                    return;
                }
                if (pass.length < 6) {
                    errEl.textContent = "Password needs to be at least 6 characters.";
                    errEl.style.display = "block";
                    return;
                }
                db.users[email] = { passHash: hash(pass), createdAt: Date.now() };
                saveDB(db);
                sessionStorage.setItem(SESSION_KEY, email);
                toast("Account created");
                renderDash();
            }
            else {
                const user = db.users[email];
                if (!user || user.passHash !== hash(pass)) {
                    errEl.textContent = "Email or password is incorrect.";
                    errEl.style.display = "block";
                    return;
                }
                sessionStorage.setItem(SESSION_KEY, email);
                toast("Welcome back");
                renderDash();
            }
        });
    }
    function userLinks(email) {
        return Object.entries(db.links)
            .filter(([, l]) => l.owner === email)
            .sort((a, b) => b[1].createdAt - a[1].createdAt);
    }
    function renderDash() {
        const email = currentUser();
        if (!email) {
            renderAuth();
            return;
        }
        authView.style.display = "none";
        dashView.style.display = "block";
        sessionInfo.innerHTML = `<span class="who">${escapeHtml(email)}</span><button class="btn-ghost" id="logoutBtn">Log out</button>`;
        sessionInfo.querySelector("#logoutBtn").addEventListener("click", () => {
            sessionStorage.removeItem(SESSION_KEY);
            renderAuth();
        });
        const links = userLinks(email);
        dashView.innerHTML = `
      <div class="create-panel">
        <p class="panel-title">New route</p>
        <form id="createForm">
          <div class="create-row">
            <div class="field">
              <label for="destInput">Destination URL</label>
              <input id="destInput" type="text" placeholder="https://example.com/very/long/path" required>
            </div>
            <div class="field short">
              <label for="codeInput">Custom code (optional)</label>
              <input id="codeInput" type="text" placeholder="auto-generated" maxlength="24">
            </div>
            <button type="submit" class="btn-primary">Create</button>
          </div>
        </form>
        <div class="patch" id="patchPreview"></div>
      </div>

      <div class="links-header">
        <h2>Your routes</h2>
        <span class="count">${links.length} total</span>
      </div>
      <div id="linksList"></div>
    `;
        const createForm = dashView.querySelector("#createForm");
        createForm.addEventListener("submit", (e) => {
            e.preventDefault();
            const destInput = dashView.querySelector("#destInput");
            const codeInput = dashView.querySelector("#codeInput");
            const destRaw = destInput.value;
            const codeRaw = codeInput.value.trim();
            if (!destRaw.trim())
                return;
            const dest = normalizeUrl(destRaw);
            let code = codeRaw ? codeRaw.replace(/[^a-zA-Z0-9\-_]/g, "") : "";
            if (code) {
                if (db.links[code]) {
                    toast("That code is taken — try another");
                    return;
                }
            }
            else {
                code = genCode();
            }
            db.links[code] = { dest, owner: email, clicks: 0, createdAt: Date.now() };
            saveDB(db);
            destInput.value = "";
            codeInput.value = "";
            lastCreated = { code, dest };
            renderDash();
            showPatchPreview();
            toast("Route created");
        });
        renderLinksList(links);
    }
    function showPatchPreview() {
        if (!lastCreated)
            return;
        const preview = document.getElementById("patchPreview");
        if (!preview)
            return;
        const shortUrl = location.origin + location.pathname + "#/r/" + lastCreated.code;
        preview.innerHTML = `
      <div class="jack">${escapeHtml(shortUrl)}</div>
      <div class="cable"></div>
      <div class="jack dest">${escapeHtml(lastCreated.dest)}</div>
    `;
        requestAnimationFrame(() => preview.classList.add("show"));
    }
    function renderLinksList(links) {
        const list = document.getElementById("linksList");
        if (!list)
            return;
        if (links.length === 0) {
            list.innerHTML = `<div class="empty">No routes yet. Create one above — it'll show up here with a live click count.</div>`;
            return;
        }
        list.innerHTML = links
            .map(([code, link]) => {
            return `
          <div class="link-row" data-code="${escapeHtml(code)}">
            <div class="link-main">
              <div class="link-code">/${escapeHtml(code)}</div>
              <div class="link-dest" title="${escapeHtml(link.dest)}">${escapeHtml(link.dest)}</div>
            </div>
            <div class="link-clicks"><b>${link.clicks || 0}</b>clicks</div>
            <button class="icon-btn" data-action="copy" title="Copy short link">⧉</button>
            <button class="icon-btn danger" data-action="delete" title="Delete">✕</button>
          </div>
        `;
        })
            .join("");
        list.querySelectorAll(".link-row").forEach((row) => {
            const code = row.dataset.code;
            row.querySelector('[data-action="copy"]').addEventListener("click", () => {
                var _a;
                const shortUrl = location.origin + location.pathname + "#/r/" + code;
                (_a = navigator.clipboard) === null || _a === void 0 ? void 0 : _a.writeText(shortUrl).then(() => toast("Copied: " + shortUrl)).catch(() => toast(shortUrl));
            });
            row.querySelector('[data-action="delete"]').addEventListener("click", () => {
                delete db.links[code];
                saveDB(db);
                toast("Route deleted");
                renderDash();
            });
        });
    }
    /* ------------------------------ Boot ------------------------------ */
    window.addEventListener("hashchange", () => {
        if (tryHandleRedirect())
            return;
        el("app").style.display = "block";
        el("redirectScreen").style.display = "none";
        currentUser() ? renderDash() : renderAuth();
    });
    if (!tryHandleRedirect()) {
        currentUser() ? renderDash() : renderAuth();
    }
})();
