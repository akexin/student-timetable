#!/usr/bin/env node
'use strict';

/**
 * 把 src/*.js（CommonJS）打包成浏览器可用的 public/offline/bundle.js。
 *
 * 设计原则：不转译、不改写业务代码。只做两件事——
 *   1. 每个文件包进 __TT.define(name, function(module, exports, require, __dirname, __filename){...})
 *   2. 把 Node 内置模块的 require 交给 public/offline/runtime.js 的 shim
 *
 * 因此 src/ 下的代码在服务器模式与离线模式下跑的是同一份源码，不存在双份实现漂移。
 *
 * 用法：node scripts/build-standalone.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const OUT_FILE = path.join(ROOT, 'public', 'offline', 'bundle.js');

/** 打包顺序只影响可读性，不影响正确性（require 是惰性的） */
const MODULES = ['util', 'model', 'ics', 'xlsx', 'store', 'importers', 'exporters', 'server'];

/** runtime.js 已提供实现的内置模块 */
const SHIMMED = new Set(['fs', 'path', 'crypto', 'http', 'url', 'os', 'child_process']);

function fail(msg) {
  console.error('\n[build-standalone] 错误：' + msg + '\n');
  process.exit(1);
}

/** 收集源码里所有 require('literal') 的模块名 */
function collectRequires(code) {
  const names = new Set();
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return [...names];
}

function indent(code, spaces) {
  const pad = ' '.repeat(spaces);
  return code
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}

function main() {
  if (!fs.existsSync(SRC_DIR)) fail('找不到 src 目录：' + SRC_DIR);

  const parts = [];
  const problems = [];

  // ---------- 第一遍：读取 + 依赖校验 ----------
  const sources = new Map();
  for (const name of MODULES) {
    const file = path.join(SRC_DIR, name + '.js');
    if (!fs.existsSync(file)) fail('缺少源文件：' + file);
    const code = fs.readFileSync(file, 'utf8');
    sources.set(name, code);

    for (const dep of collectRequires(code)) {
      if (dep.startsWith('.')) {
        const depName = dep.replace(/^\.\//, '').replace(/\.js$/, '');
        if (!MODULES.includes(depName)) {
          problems.push(`${name}.js 依赖 ./${depName}，但未列入打包清单`);
        }
      } else if (!SHIMMED.has(dep)) {
        problems.push(`${name}.js 依赖内置模块 '${dep}'，runtime.js 未提供 shim`);
      }
    }
  }

  if (problems.length) {
    fail('依赖校验未通过：\n  - ' + problems.join('\n  - '));
  }

  // ---------- 第二遍：生成 bundle ----------
  parts.push('/* 学生课表系统 —— 离线业务包（自动生成，请勿手工修改） */');
  parts.push('/* 源文件：src/{' + MODULES.join(',') + '}.js                          */');
  parts.push('/* 生成命令：node scripts/build-standalone.js                        */');
  parts.push('(function () {');
  parts.push("  'use strict';");
  parts.push('  var T = window.__TT;');
  parts.push('  if (!T) { throw new Error("offline/runtime.js 必须先于 bundle.js 加载"); }');
  parts.push('');

  for (const name of MODULES) {
    const code = sources.get(name);
    parts.push('  /* ======================= ' + name + '.js ======================= */');
    parts.push("  T.define('" + name + "', function (module, exports, require, __dirname, __filename) {");
    // __dirname 统一为 /src，使 store.js 的 path.resolve(__dirname, '..') 得到 /
    parts.push(indent(code.replace(/\s+$/, ''), 4));
    parts.push('  });');
    parts.push('');
  }

  parts.push('  T.boot();');
  parts.push('})();');
  parts.push('');

  const output = parts.join('\n');

  // ---------- 语法自检（用 Function 构造器，不执行） ----------
  try {
    // eslint-disable-next-line no-new-func
    new Function(output);
  } catch (e) {
    fail('生成的 bundle 存在语法错误：' + e.message);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, output, 'utf8');

  const kb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
  console.log('[build-standalone] 已生成 ' + path.relative(ROOT, OUT_FILE) + '（' + kb + ' KB，' + MODULES.length + ' 个模块）');
  console.log('[build-standalone] 模块：' + MODULES.join(', '));
}

main();
