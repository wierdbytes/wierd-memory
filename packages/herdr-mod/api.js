// The wierd-memory server (docs/api.md in the wierd-memory repository): JSON over
// HTTP on this computer. Every request says who asks (`x-wmem-client: herdr`):
// the server records it in commit messages and review decisions.

export const DEFAULT_SERVER = "http://127.0.0.1:7433";

export class Api {
  constructor(url) {
    this.url = String(url || DEFAULT_SERVER).replace(/\/+$/, "");
  }

  // The answer's JSON. Throws an Error with the server's own words (`error`)
  // and `status`; `offline` is set when the server couldn't be reached at all.
  async call(method, path, body) {
    const headers = { "x-wmem-client": "herdr" };
    const options = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${this.url}${path}`, options);
    } catch (e) {
      const err = new Error(String(e?.message ?? e));
      err.offline = true;
      throw err;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (a proxy's page, a crash): the status says the rest.
    }
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  get(path) {
    return this.call("GET", path);
  }

  post(path, body = {}) {
    return this.call("POST", path, body);
  }

  patch(path, body) {
    return this.call("PATCH", path, body);
  }

  del(path) {
    return this.call("DELETE", path);
  }
}
