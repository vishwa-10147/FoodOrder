const http = require("http");
const fs = require("fs");
const PORT = 3040;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const request = http.request(
      { hostname: "localhost", port: PORT, path, method, headers: { "Content-Type": "application/json" } },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(responseBody); } catch {}
          resolve({ code: res.statusCode, json, body: responseBody });
        });
      }
    );
    request.on("error", reject);
    if (data) request.write(data);
    request.end();
  });
}

(async () => {
  const state1 = await req("GET", "/api/state");
  const item = state1.json?.menu?.[0];
  if (!item) {
    console.log(JSON.stringify({ error: "No menu item" }, null, 2));
    return;
  }

  const setUnavailable = await req("POST", `/api/menu/${item.id}/availability`, { available: false });
  const state2 = await req("GET", "/api/state");
  const after = state2.json?.menu?.find((m) => m.id === item.id);
  const restore = await req("POST", `/api/menu/${item.id}/availability`, { available: true });

  const clientHtml = fs.readFileSync("d:/Projects/FoodOrdering/client.html", "utf8");
  const uiHasBadge = clientHtml.includes("Temporarily unavailable") && clientHtml.includes("add:disabled");

  console.log(JSON.stringify({
    stateCode: state1.code,
    setUnavailableCode: setUnavailable.code,
    afterUnavailableFlag: after?.available,
    restoreCode: restore.code,
    uiHasBadgeAndDisabledStyle: uiHasBadge
  }, null, 2));
})();
