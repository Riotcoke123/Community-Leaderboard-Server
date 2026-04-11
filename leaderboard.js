// Helper: show medal for top ranks
function getRankDisplay(rank) {
    if (rank === 1) return "🥇";
    if (rank === 2) return "🥈";
    if (rank === 3) return "🥉";
    return String(rank);
}

// Helper: escape a value to a safe number string, fallback to 0
function safeInt(val) {
    const n = parseInt(val, 10);
    return isNaN(n) ? 0 : n;
}

// Helper: safely build a <tr> row using DOM methods only — no innerHTML with user data
function buildRow(u, rank) {
    const tr = document.createElement("tr");

    // Rank cell
    const tdRank = document.createElement("td");
    tdRank.className = "col-rank";
    const rankInner = document.createElement("div");
    rankInner.className = "rank-inner";
    // getRankDisplay returns only emoji or a plain number — safe to set as textContent
    rankInner.textContent = getRankDisplay(rank);
    tdRank.appendChild(rankInner);

    // Username cell — author comes from the server; treat as untrusted text
    const tdUser = document.createElement("td");
    tdUser.className = "col-username";
    const userInner = document.createElement("div");
    userInner.className = "username-inner";
    const link = document.createElement("a");
    // Build the href with encodeURIComponent so a crafted username can't break the URL
    link.href = `https://communities.win/u/${encodeURIComponent(u.author)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = u.author;   // textContent — never interpreted as HTML
    userInner.appendChild(link);
    tdUser.appendChild(userInner);

    // Posts cell — coerce to integer before display
    const tdPosts = document.createElement("td");
    tdPosts.className = "col-posts";
    tdPosts.textContent = safeInt(u.post_count).toLocaleString();

    // Last active cell — treat as untrusted text
    const tdActive = document.createElement("td");
    tdActive.className = "col-active last-active";
    tdActive.textContent = u.last_active_ago || "Unknown";

    // Score cell — coerce to integer before display
    const tdScore = document.createElement("td");
    tdScore.className = "col-score";
    const scoreSpan = document.createElement("span");
    scoreSpan.className = "score-value";
    scoreSpan.textContent = safeInt(u.calculated_score).toLocaleString();
    tdScore.appendChild(scoreSpan);

    tr.append(tdRank, tdUser, tdPosts, tdActive, tdScore);
    return tr;
}

// Load leaderboard from API
async function loadLeaderboard() {
    const tbody = document.getElementById("leaderboard");

    try {
        const res = await fetch("/api/leaderboard");

        // Reject non-OK responses immediately
        if (!res.ok) {
            throw new Error(`Server returned ${res.status}`);
        }

        // Guard against a non-JSON content-type
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) {
            throw new Error("Unexpected response type from server");
        }

        const data = await res.json();

        // Validate that the payload is an array
        if (!Array.isArray(data)) {
            throw new Error("Unexpected data format from server");
        }

        tbody.innerHTML = "";

        let sumPosts = 0;
        let sumScore = 0;

        // Build rows using safe DOM methods
        const fragment = document.createDocumentFragment();
        data.forEach((u, i) => {
            // Skip malformed entries
            if (!u || typeof u.author !== "string" || !u.author.trim()) return;

            sumPosts += safeInt(u.post_count);
            sumScore += safeInt(u.calculated_score);

            fragment.appendChild(buildRow(u, i + 1));
        });
        tbody.appendChild(fragment);

        // Update stats
        document.getElementById("totalUsers").textContent = data.length.toLocaleString();
        document.getElementById("totalPosts").textContent = sumPosts.toLocaleString();
        document.getElementById("totalScore").textContent = sumScore.toLocaleString();
        document.getElementById("lastUpdated").textContent = new Date().toLocaleTimeString();

    } catch (err) {
        console.error("Failed to load leaderboard:", err);
        // Safe error display — no user-controlled text reaches the DOM here
        tbody.innerHTML = "";
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.className = "loading";
        td.textContent = "Failed to load leaderboard. Please try again later.";
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
}

// Initial load on page open
loadLeaderboard();

// Refresh every 90 seconds
setInterval(loadLeaderboard, 90 * 1000);