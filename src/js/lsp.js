const invoke   = window.__TAURI__?.core.invoke;
const tauriEvt = window.__TAURI__?.event;

export class LspClient {
  constructor({ language, onDiagnostics, onStatus }) {
    this.language      = language;
    this.onDiagnostics = onDiagnostics ?? (() => {});
    this.onStatus      = onStatus      ?? (() => {});
    this._id           = 1;
    this._pending      = new Map();   // id → {resolve, reject}
    this._unlistens    = [];
    this._docVersions  = new Map();   // uri → version
    this._rootUri      = '';
    this.running       = false;
  }

  async start(binary, args, workspace) {
    if (!invoke || !tauriEvt) throw new Error('Tauri not available');
    this._hasOpened = false;
    this.onStatus('starting');

    this._unlistens.push(await tauriEvt.listen('lsp-message', ev => {
      if (ev.payload.language !== this.language) return;
      try { this._handle(JSON.parse(ev.payload.data)); } catch {}
    }));

    this._unlistens.push(await tauriEvt.listen('lsp-exit', ev => {
      if (ev.payload.language !== this.language) return;
      this.running = false;
      this.onStatus('stopped');
      for (const { reject } of this._pending.values())
        reject(new Error('LSP server exited'));
      this._pending.clear();
    }));

    try {
      await invoke('lsp_start', { language: this.language, binary, args, workspace });
    } catch (e) {
      this._cleanup();
      this.onStatus('error');
      throw e;
    }

    this._rootUri = this._pathToUri(workspace);
    try {
      await this._initialize(workspace);
    } catch (e) {
      // Handshake failed or timed out — kill the orphaned server process
      invoke?.('lsp_stop', { language: this.language }).catch(() => {});
      this._cleanup();
      this.onStatus('error');
      throw e;
    }
    invoke?.('lsp_confirm_initialized', { language: this.language }).catch(() => {});
    this.running = true;
    this.onStatus('running');
  }

  async _initialize(workspace) {
    const name = (workspace || '').replace(/\\/g, '/').split('/').pop() || 'workspace';
    await this._request('initialize', {
      processId: null,
      clientInfo: { name: 'LittleNotepad', version: '0.0.1' },
      rootUri: this._rootUri,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            didSave: false,
            willSave: false,
            willSaveWaitUntil: false,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: { snippetSupport: false, documentationFormat: ['plaintext'] },
            contextSupport: true,
          },
          publishDiagnostics: { relatedInformation: false, versionSupport: false },
          hover: { dynamicRegistration: false, contentFormat: ['plaintext'] },
          definition: { dynamicRegistration: false, linkSupport: true },
          rename: { dynamicRegistration: false, prepareSupport: false },
          codeAction: {
            dynamicRegistration: false,
            codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } },
          },
        },
        workspace: { applyEdit: true },
      },
      workspaceFolders: workspace
        ? [{ uri: this._rootUri, name }]
        : null,
    });
    this._notify('initialized', {});
  }


  openDoc(filePath, content, languageId = 'python') {
    if (!this.running) return;
    this._hasOpened = true;
    const uri = this._pathToUri(filePath);
    this._docVersions.set(uri, 1);
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  changeDoc(filePath, content) {
    if (!this.running) return;
    const uri = this._pathToUri(filePath);
    const ver = (this._docVersions.get(uri) ?? 0) + 1;
    this._docVersions.set(uri, ver);
    this._notify('textDocument/didChange', {
      textDocument: { uri, version: ver },
      contentChanges: [{ text: content }],
    });
  }

  closeDoc(filePath) {
    if (!this.running) return;
    const uri = this._pathToUri(filePath);
    this._docVersions.delete(uri);
    this._notify('textDocument/didClose', { textDocument: { uri } });
  }


  async complete(filePath, line, character, dotTrigger = false) {
    if (!this.running) return [];
    try {
      const uri = this._pathToUri(filePath);
      const res = await this._request('textDocument/completion', {
        textDocument: { uri },
        position: { line, character },
        context: { triggerKind: 1 },
      });
      if (!res) return [];
      const items = Array.isArray(res) ? res : (res.items ?? []);
      return items.slice(0, 50);
    } catch { return []; }
  }

  async goToDefinition(filePath, line, character) {
    if (!this.running) return null;
    try {
      const uri = this._pathToUri(filePath);
      const res = await this._request('textDocument/definition', {
        textDocument: { uri }, position: { line, character },
      });
      if (!res) return null;
      const locs = Array.isArray(res) ? res : [res];
      return locs.map(loc => ({
        uri:   loc.targetUri  ?? loc.uri,
        range: loc.targetSelectionRange ?? loc.targetRange ?? loc.range,
      })).filter(l => l.uri && l.range);
    } catch { return null; }
  }

  async codeAction(filePath, line, character, diagnostics) {
    if (!this.running) return [];
    try {
      const uri = this._pathToUri(filePath);
      const pos = { line, character };
      const res = await this._request('textDocument/codeAction', {
        textDocument: { uri },
        range: { start: pos, end: pos },
        context: { diagnostics: diagnostics ?? [], triggerKind: 2 },
      });
      return Array.isArray(res) ? res : [];
    } catch { return []; }
  }

  async rename(filePath, line, character, newName) {
    if (!this.running) return null;
    try {
      const uri = this._pathToUri(filePath);
      return await this._request('textDocument/rename', {
        textDocument: { uri }, position: { line, character }, newName,
      });
    } catch { return null; }
  }


  async stop() {
    if (!this.running) return;
    try { await this._request('shutdown', null); } catch {}
    this._notify('exit', null);
    this.running = false;
    await invoke?.('lsp_stop', { language: this.language }).catch(() => {});
    this._cleanup();
    this.onStatus('stopped');
  }


  _request(method, params) {
    const id = this._id++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`LSP timeout: ${method}`));
        }
      }, 15_000);
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _send(msg) {
    const json = JSON.stringify(msg);
    invoke?.('lsp_send', { language: this.language, message: json }).catch(() => {});
  }

  _handle(msg) {
    if (msg.id != null) {
      const p = this._pending.get(msg.id);
      if (p) {
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP error'));
        else p.resolve(msg.result);
      }
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      this.onDiagnostics(msg.params.uri, msg.params.diagnostics ?? []);
    }
  }

  _cleanup() {
    for (const u of this._unlistens) u();
    this._unlistens = [];
  }

  _pathToUri(p) {
    if (!p) return '';
    const norm = p.replace(/\\/g, '/');
    return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
  }
}
