/* 学生课表系统 —— 离线运行时（Standalone Runtime）
 * ---------------------------------------------------------------------------
 * 目的：让原本"Node 后端 + 静态前端"的课表系统，在 Android WebView 中不依赖
 *       任何服务器即可完整运行。
 *
 * 思路（关键）：不改动 src/ 下一行业务代码，而是补齐它依赖的运行环境——
 *   1. Buffer        —— xlsx.js / ics.js 的二进制操作
 *   2. crypto        —— util.js 的 randomBytes
 *   3. fs / path     —— store.js 的 JSON 持久化（改为内存 + IndexedDB 落盘）
 *   4. http / url    —— server.js 的顶层 require（start() 在浏览器不会执行）
 *   5. CommonJS      —— 极简 define / require
 *   6. fetch 拦截     —— 把 /api/** 与 /ics/** 转交给 server.js 的 handle()
 *
 * 因此后端全部路由、鉴权、参数校验、导入导出逻辑都被原样复用。
 * 服务器模式（node src/server.js）不受任何影响：本文件只在离线入口加载。
 */
(function (global) {
  'use strict';

  var textEncoder = new TextEncoder();
  var textDecoder = new TextDecoder('utf-8');

  /* ============================ 1. Buffer ============================ */

  function Buf(length) {
    return new Uint8Array(length);
  }

  var BufProto = {
    toString: function (encoding) {
      if (encoding === 'hex') {
        var hex = '';
        for (var i = 0; i < this.length; i++) hex += (this[i] < 16 ? '0' : '') + this[i].toString(16);
        return hex;
      }
      if (encoding === 'base64' || encoding === 'base64url') {
        var bin = '';
        for (var j = 0; j < this.length; j++) bin += String.fromCharCode(this[j]);
        var b64 = global.btoa(bin);
        return encoding === 'base64url'
          ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
          : b64;
      }
      return textDecoder.decode(this);
    },
    slice: function (start, end) {
      return Buf.wrap(Uint8Array.prototype.slice.call(this, start, end));
    },
    copy: function (target, targetStart, sourceStart, sourceEnd) {
      var ts = targetStart || 0;
      var ss = sourceStart || 0;
      var se = sourceEnd === undefined ? this.length : sourceEnd;
      var part = this.subarray(ss, se);
      target.set(part, ts);
      return part.length;
    },
    writeUInt8: function (value, offset) {
      this[offset || 0] = value & 0xff;
      return (offset || 0) + 1;
    },
    writeUInt16LE: function (value, offset) {
      var o = offset || 0;
      new DataView(this.buffer, this.byteOffset).setUint16(o, value, true);
      return o + 2;
    },
    writeUInt32LE: function (value, offset) {
      var o = offset || 0;
      new DataView(this.buffer, this.byteOffset).setUint32(o, value >>> 0, true);
      return o + 4;
    },
    readUInt32LE: function (offset) {
      return new DataView(this.buffer, this.byteOffset).getUint32(offset || 0, true);
    },
    equals: function (other) {
      if (!other || other.length !== this.length) return false;
      for (var i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    },
  };

  function installBufferProto(u8) {
    Object.keys(BufProto).forEach(function (k) {
      Object.defineProperty(u8, k, { value: BufProto[k], writable: true, configurable: true });
    });
    return u8;
  }

  Buf.wrap = function (u8) {
    var out = new Uint8Array(u8.length);
    out.set(u8);
    return installBufferProto(out);
  };

  Buf.from = function (value, encoding) {
    if (typeof value === 'string') return Buf.wrap(textEncoder.encode(value));
    if (value instanceof ArrayBuffer) return Buf.wrap(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Buf.wrap(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (Array.isArray(value)) return Buf.wrap(new Uint8Array(value));
    throw new TypeError('Buffer.from: 不支持的类型 ' + typeof value);
  };

  Buf.alloc = function (size, fill) {
    var out = new Uint8Array(size || 0);
    if (fill) out.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill);
    return installBufferProto(out);
  };

  Buf.isBuffer = function (x) {
    // 浏览器里所有 Uint8Array 都按 Buffer 处理即可（我们只关心"是否已是二进制"）
    return x instanceof Uint8Array;
  };

  Buf.concat = function (list, totalLength) {
    var len = totalLength;
    if (len === undefined) {
      len = 0;
      for (var i = 0; i < list.length; i++) len += list[i].length;
    }
    var out = new Uint8Array(len);
    var off = 0;
    for (var j = 0; j < list.length; j++) {
      out.set(list[j], off);
      off += list[j].length;
    }
    return installBufferProto(out);
  };

  /* ============================ 2. 内置模块 shim ============================ */

  var cryptoShim = {
    randomBytes: function (n) {
      var a = new Uint8Array(n);
      (global.crypto || global.msCrypto).getRandomValues(a);
      return Buf.wrap(a);
    },
    randomUUID: function () {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
      var b = cryptoShim.randomBytes(16).toString('hex');
      return b.slice(0, 8) + '-' + b.slice(8, 12) + '-' + b.slice(12, 16) + '-' + b.slice(16, 20) + '-' + b.slice(20);
    },
  };

  function normalizePath(p) {
    var absolute = p.charAt(0) === '/';
    var parts = [];
    var segments = p.split('/');
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return (absolute ? '/' : '') + parts.join('/');
  }

  var pathShim = {
    sep: '/',
    resolve: function () {
      var p = '';
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        if (!a) continue;
        p = a.charAt(0) === '/' || !p ? a : p + '/' + a;
      }
      if (p.charAt(0) !== '/') p = '/' + p;
      return normalizePath(p);
    },
    join: function () {
      return normalizePath(Array.prototype.filter.call(arguments, Boolean).join('/'));
    },
    dirname: function (p) {
      var i = p.lastIndexOf('/');
      return i <= 0 ? '/' : p.slice(0, i);
    },
    basename: function (p) {
      var i = p.lastIndexOf('/');
      return i < 0 ? p : p.slice(i + 1);
    },
    extname: function (p) {
      var b = pathShim.basename(p);
      var i = b.lastIndexOf('.');
      return i <= 0 ? '' : b.slice(i);
    },
  };

  var httpShim = {
    createServer: function () {
      throw new Error('离线模式下不监听端口；请使用内置的 fetch 拦截层');
    },
  };

  var osShim = {
    platform: function () { return 'android'; },
    networkInterfaces: function () { return {}; },
  };

  var processShim = {
    env: {},
    argv: ['node', 'offline'],
    platform: 'browser',
    version: 'v0.0.0-offline',
    cwd: function () { return '/'; },
    nextTick: function (fn) { Promise.resolve().then(fn); },
    on: function () {},
  };

  /* ============================ 3. 虚拟文件系统 + IndexedDB ============================ */

  var IDB_NAME = 'stt-offline';
  var IDB_STORE = 'files';
  var virtualFiles = new Map();
  var idb = null;
  var flushTimer = null;
  var dirty = false;

  var fsShim = {
    existsSync: function (p) { return virtualFiles.has(normalizePath(p)); },
    mkdirSync: function () {},
    readFileSync: function (p, encoding) {
      var key = normalizePath(p);
      if (!virtualFiles.has(key)) {
        var err = new Error("ENOENT: no such file or directory, open '" + key + "'");
        err.code = 'ENOENT';
        throw err;
      }
      return virtualFiles.get(key);
    },
    writeFileSync: function (p, data) {
      virtualFiles.set(normalizePath(p), typeof data === 'string' ? data : textDecoder.decode(data));
      scheduleFlush();
    },
    appendFileSync: function (p, data) {
      var key = normalizePath(p);
      virtualFiles.set(key, (virtualFiles.get(key) || '') + (typeof data === 'string' ? data : textDecoder.decode(data)));
      scheduleFlush();
    },
    copyFileSync: function (from, to) {
      var src = normalizePath(from);
      if (virtualFiles.has(src)) virtualFiles.set(normalizePath(to), virtualFiles.get(src));
      scheduleFlush();
    },
    renameSync: function (from, to) {
      var src = normalizePath(from);
      if (virtualFiles.has(src)) {
        virtualFiles.set(normalizePath(to), virtualFiles.get(src));
        virtualFiles.delete(src);
      }
      scheduleFlush();
    },
    unlinkSync: function (p) {
      virtualFiles.delete(normalizePath(p));
      scheduleFlush();
    },
    statSync: function () {
      return { isDirectory: function () { return false; }, isFile: function () { return true; }, size: 0 };
    },
    readdirSync: function () { return []; },
    createReadStream: function () {
      throw new Error('离线模式不支持 createReadStream');
    },
  };

  function openIDB() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('当前环境不支持 IndexedDB'));
      var req = global.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB 被占用')); };
    });
  }

  function preloadFiles() {
    return openIDB().then(function (db) {
      idb = db;
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var cursorReq = tx.objectStore(IDB_STORE).openCursor();
        cursorReq.onsuccess = function () {
          var cursor = cursorReq.result;
          if (cursor) {
            virtualFiles.set(cursor.key, cursor.value);
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = function () { reject(cursorReq.error); };
      });
    });
  }

  function scheduleFlush() {
    dirty = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flushNow(); }, 400);
  }

  function flushNow() {
    if (!dirty || !idb) return Promise.resolve();
    dirty = false;
    return new Promise(function (resolve) {
      try {
        var tx = idb.transaction(IDB_STORE, 'readwrite');
        var os = tx.objectStore(IDB_STORE);
        virtualFiles.forEach(function (value, key) { os.put(value, key); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (e) {
        resolve();
      }
    });
  }

  /* ============================ 4. CommonJS 模块系统 ============================ */

  // 业务代码以 Node 全局变量书写（Buffer / process），这里在加载 bundle 前补齐
  global.Buffer = Buf;
  global.process = processShim;

  var moduleDefs = Object.create(null);
  var moduleCache = Object.create(null);

  function define(name, fn) {
    moduleDefs[name] = fn;
  }

  function requireModule(name) {
    if (name === 'fs') return fsShim;
    if (name === 'path') return pathShim;
    if (name === 'crypto') return cryptoShim;
    if (name === 'http') return httpShim;
    if (name === 'os') return osShim;
    if (name === 'url') return { URL: global.URL, URLSearchParams: global.URLSearchParams };
    if (name === 'child_process') {
      return { execSync: function () { throw new Error('离线模式不支持子进程'); } };
    }

    var key = String(name).replace(/^\.\//, '').replace(/\.js$/, '');
    if (moduleCache[key]) return moduleCache[key].exports;
    if (!moduleDefs[key]) throw new Error('模块未找到: ' + name);

    var mod = { exports: {}, id: key };
    moduleCache[key] = mod;
    moduleDefs[key](mod, mod.exports, requireModule, '/' + key, key + '.js');
    return mod.exports;
  }

  /* ============================ 5. fetch 拦截 ============================ */

  var nativeFetch = global.fetch ? global.fetch.bind(global) : null;

  function isOfflineRoute(pathname) {
    return pathname === '/api' || pathname.indexOf('/api/') === 0 || pathname.indexOf('/ics/') === 0;
  }

  function toBodyBuffer(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return Buf.from(body, 'utf8');
    if (body instanceof ArrayBuffer) return Buf.from(new Uint8Array(body));
    if (ArrayBuffer.isView(body)) return Buf.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    return null;
  }

  function normalizeHeaders(headers) {
    var out = {};
    if (!headers) return out;
    if (typeof global.Headers !== 'undefined' && headers instanceof global.Headers) {
      headers.forEach(function (value, key) { out[key.toLowerCase()] = value; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function (pair) { out[String(pair[0]).toLowerCase()] = pair[1]; });
    } else {
      Object.keys(headers).forEach(function (key) { out[key.toLowerCase()] = headers[key]; });
    }
    return out;
  }

  function makeReqStub(method, url, headers, bodyBuf) {
    var handlers = Object.create(null);
    var req = {
      method: method,
      url: url,
      headers: headers,
      on: function (event, cb) {
        (handlers[event] || (handlers[event] = [])).push(cb);
        return req;
      },
      once: function (event, cb) { return req.on(event, cb); },
      destroy: function () {},
      setTimeout: function () {},
    };
    // 在 readBody() 完成监听注册之后再投递数据（微任务保证顺序）
    queueMicrotask(function () {
      if (bodyBuf && bodyBuf.length && handlers.data) handlers.data.forEach(function (cb) { cb(bodyBuf); });
      if (handlers.end) handlers.end.forEach(function (cb) { cb(); });
    });
    return req;
  }

  function makeResStub(captured) {
    var res = {
      writeHead: function (status, headers) {
        captured.status = status;
        if (headers) Object.keys(headers).forEach(function (k) { captured.headers[k] = headers[k]; });
        return res;
      },
      setHeader: function (k, v) { captured.headers[k] = v; },
      getHeader: function (k) { return captured.headers[k]; },
      removeHeader: function (k) { delete captured.headers[k]; },
      write: function (chunk) { if (chunk != null) captured.chunks.push(chunk); return true; },
      end: function (chunk) { if (chunk != null) captured.chunks.push(chunk); return res; },
    };
    return res;
  }

  function mergeChunks(chunks) {
    if (!chunks.length) return Buf.alloc(0);
    if (chunks.length === 1) {
      var only = chunks[0];
      return typeof only === 'string' ? Buf.from(only, 'utf8') : Buf.wrap(only);
    }
    var bufs = chunks.map(function (c) { return typeof c === 'string' ? Buf.from(c, 'utf8') : c; });
    return Buf.concat(bufs);
  }

  function makeResponse(status, headers, body) {
    var lower = {};
    Object.keys(headers || {}).forEach(function (k) { lower[k.toLowerCase()] = headers[k]; });
    return {
      ok: status >= 200 && status < 300,
      status: status,
      statusText: '',
      headers: {
        get: function (name) { var k = String(name).toLowerCase(); return lower[k] === undefined ? null : lower[k]; },
        has: function (name) { return String(name).toLowerCase() in lower; },
        forEach: function (cb) { Object.keys(lower).forEach(function (k) { cb(lower[k], k); }); },
      },
      async text() { return textDecoder.decode(body); },
      async json() { return JSON.parse(textDecoder.decode(body)); },
      async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.length); },
      async blob() { return new Blob([body], { type: lower['content-type'] || 'application/octet-stream' }); },
    };
  }

  function installFetchInterceptor(handle) {
    global.fetch = function (input, init) {
      var rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
      var parsed;
      try {
        parsed = new URL(rawUrl, global.location.href);
      } catch (e) {
        return nativeFetch ? nativeFetch(input, init) : Promise.reject(e);
      }

      if (!isOfflineRoute(parsed.pathname)) {
        if (!nativeFetch) return Promise.reject(new Error('原生 fetch 不可用'));
        return nativeFetch(input, init);
      }

      var opts = init || {};
      var method = (opts.method || (input && input.method) || 'GET').toUpperCase();
      var headers = normalizeHeaders(opts.headers || (input && input.headers));
      if (!headers.host) headers.host = global.location.host || 'localhost';
      if (!headers['content-type'] && typeof opts.body === 'string') headers['content-type'] = 'application/json';

      var bodyBuf = toBodyBuffer(opts.body);
      var captured = { status: 200, headers: {}, chunks: [] };
      var req = makeReqStub(method, parsed.pathname + parsed.search, headers, bodyBuf);
      var res = makeResStub(captured);

      return Promise.resolve(handle(req, res)).then(function () {
        return makeResponse(captured.status, captured.headers, mergeChunks(captured.chunks));
      });
    };
  }

  /* ============================ 6. 启动 ============================ */

  function seedConfig() {
    var CONFIG_FILE = '/data/config.json';
    if (!virtualFiles.has(CONFIG_FILE)) {
      virtualFiles.set(CONFIG_FILE, JSON.stringify({
        apiKey: 'local',
        port: 0,
        host: 'local',
        publicBaseUrl: '',
        timezone: 'Asia/Shanghai',
        remindBeforeMinutes: 15,
        icsMode: 'recurrence',
        createdAt: new Date().toISOString(),
      }, null, 2));
      dirty = true;
    }
    try {
      global.localStorage.setItem('stt_apikey', 'local');
    } catch (e) { /* 隐私模式下忽略 */ }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function ensureDefaultTerm(store) {
    try {
      if (store.db && store.db.terms && store.db.terms.length) return;
      var now = new Date();
      var offset = (now.getDay() + 6) % 7; // 本周一
      var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      store.createTerm({
        name: now.getFullYear() + '-' + (now.getFullYear() + 1) + ' 学年',
        startDate: isoDate(monday),
        weeks: 20,
      });
    } catch (e) {
      console.warn('[TT] 创建默认学期失败：', e && e.message);
    }
  }

  function loadAppScript() {
    var s = document.createElement('script');
    s.src = 'app.js';
    s.async = false;
    s.onerror = function () { console.error('[TT] app.js 加载失败'); };
    s.onload = function () { installNativeDownloader(); };
    document.body.appendChild(s);
  }

  /**
   * WebView 对 <a download> + blob: 的支持不完整，导出 CSV/XLSX/ICS 时会静默失败。
   * 因此 app.js 加载完成后接管其全局 downloadBlob()，改走原生保存通道
   * （MainActivity 里的 AndroidSaver.saveBase64 → 系统「下载」目录）。
   */
  function installNativeDownloader() {
    if (!global.AndroidSaver || typeof global.AndroidSaver.saveBase64 !== 'function') return;

    global.downloadBlob = function (buf, filename, contentType) {
      try {
        var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        var binary = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < u8.length; i += CHUNK) {
          binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        global.AndroidSaver.saveBase64(global.btoa(binary), filename, contentType || 'application/octet-stream');
      } catch (e) {
        console.error('[TT] 保存文件失败', e);
        if (global.alert) global.alert('保存文件失败：' + (e && e.message));
      }
    };
  }

  function boot() {
    return preloadFiles()
      .catch(function (e) {
        console.warn('[TT] IndexedDB 不可用，数据仅在本次会话内有效：', e && e.message);
      })
      .then(function () {
        seedConfig();

        var store = requireModule('store');
        store.init();
        ensureDefaultTerm(store);

        var server = requireModule('server');
        installFetchInterceptor(server.handle);

        global.__TT_READY__ = true;
        flushNow().then(loadAppScript);
      });
  }

  global.addEventListener('pagehide', function () { flushNow(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushNow();
  });

  global.__TT = {
    define: define,
    require: requireModule,
    boot: boot,
    Buffer: Buf,
    flush: flushNow,
    get files() { return virtualFiles; },
  };
})(window);
