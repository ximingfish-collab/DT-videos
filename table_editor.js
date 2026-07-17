"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { exec } = require("node:child_process");

const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, "index.html");
const EDITOR_PATH = path.join(ROOT, "table_editor.html");
const HOST = "127.0.0.1";
const PORT = 8765;
const MARKDOWN_PATTERN = /(\bconst\s+markdown\s*=\s*)("(?:\\.|[^"\\])*")(\s*;)/s;
const SEPARATOR_PATTERN = /^\s*\|?[\s:|-]+\|\s*$/;
const HEADING_PATTERN = /^(#{1,3})\s+(.+)$/;

class EditorError extends Error {}

function readSource() {
  try {
    return fs.readFileSync(INDEX_PATH, "utf8");
  } catch (error) {
    throw new EditorError(`无法读取 index.html：${error.message}`);
  }
}

function extractMarkdown(source) {
  const match = MARKDOWN_PATTERN.exec(source);
  if (!match) throw new EditorError("未在 index.html 中找到 const markdown 数据。");
  try {
    return { match, markdown: JSON.parse(match[2]) };
  } catch {
    throw new EditorError("index.html 中的 markdown 字符串格式无效。");
  }
}

function splitRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  return value.split("|").map(part => part.trim());
}

function parseTables(markdown) {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const hasFinalNewline = markdown.endsWith("\n");
  const lines = markdown.split(/\r?\n/);
  if (hasFinalNewline) lines.pop();

  const tables = [];
  let section = "";
  let subsection = "";
  let i = 0;

  while (i < lines.length) {
    const heading = lines[i].match(HEADING_PATTERN);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (level === 2) {
        section = title;
        subsection = "";
      } else if (level === 3) {
        subsection = title;
      }
    }

    if (
      lines[i].trim().startsWith("|")
      && i + 1 < lines.length
      && SEPARATOR_PATTERN.test(lines[i + 1])
    ) {
      const start = i;
      const headers = splitRow(lines[i]);
      const separator = splitRow(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = splitRow(lines[i]);
        rows.push([...row, ...Array(headers.length).fill("")].slice(0, headers.length));
        i += 1;
      }
      tables.push({
        id: tables.length,
        title: [section, subsection].filter(Boolean).join(" / ") || `表格 ${tables.length + 1}`,
        headers,
        separator,
        rows,
        _start: start,
        _end: i,
      });
      continue;
    }
    i += 1;
  }

  return { lines, newline, hasFinalNewline, tables };
}

function versionOf(markdown) {
  return crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
}

function publicDocument() {
  const { markdown } = extractMarkdown(readSource());
  const { tables } = parseTables(markdown);
  return {
    version: versionOf(markdown),
    tables: tables.map(({ _start, _end, ...table }) => table),
  };
}

function cleanCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ").trim();
  if (text.includes("|")) {
    throw new EditorError("单元格不能包含半角竖线“|”，请改用全角“｜”。");
  }
  return text;
}

function saveDocument(payload) {
  const source = readSource();
  const { match, markdown } = extractMarkdown(source);
  if (payload.version !== versionOf(markdown)) {
    throw new EditorError("index.html 已在别处发生变化，请刷新编辑器后重试。");
  }

  const parsed = parseTables(markdown);
  const submittedTables = payload.tables;
  if (!Array.isArray(submittedTables) || submittedTables.length !== parsed.tables.length) {
    throw new EditorError("提交的表格数量与 index.html 不一致。");
  }

  const replacements = parsed.tables.flatMap((current, index) => {
    const submitted = submittedTables[index];
    if (submitted.id !== current.id) {
      throw new EditorError("表格顺序已改变，请刷新后重试。");
    }
    if (!Array.isArray(submitted.rows)) {
      throw new EditorError(`“${current.title}”的行数据无效。`);
    }
    const rows = submitted.rows.map(row => {
      if (!Array.isArray(row)) throw new EditorError(`“${current.title}”中存在无效行。`);
      const cells = row.map(cleanCell);
      return [...cells, ...Array(current.headers.length).fill("")].slice(0, current.headers.length);
    });
    if (JSON.stringify(rows) === JSON.stringify(current.rows)) return [];
    return [{
      start: current._start,
      end: current._end,
      lines: [
        `| ${current.headers.join(" | ")} |`,
        `| ${current.separator.join(" | ")} |`,
        ...rows.map(row => `| ${row.join(" | ")} |`),
      ],
    }];
  });

  replacements.reverse().forEach(replacement => {
    parsed.lines.splice(
      replacement.start,
      replacement.end - replacement.start,
      ...replacement.lines,
    );
  });

  let updatedMarkdown = parsed.lines.join(parsed.newline);
  if (parsed.hasFinalNewline) updatedMarkdown += parsed.newline;
  const replacement = match[1] + JSON.stringify(updatedMarkdown) + match[3];
  const updatedSource = source.slice(0, match.index) + replacement
    + source.slice(match.index + match[0].length);

  if (updatedSource === source) return publicDocument();

  const backupPath = `${INDEX_PATH}.bak`;
  const tempPath = `${INDEX_PATH}.tmp`;
  try {
    fs.copyFileSync(INDEX_PATH, backupPath);
    fs.writeFileSync(tempPath, updatedSource, "utf8");
    fs.renameSync(tempPath, INDEX_PATH);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw new EditorError(`写入文件失败：${error.message}`);
  }
  return publicDocument();
}

function send(res, status, contentType, body) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": content.length,
    "Cache-Control": "no-store",
  });
  res.end(content);
}

function sendJson(res, status, data) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/table_editor.html")) {
    try {
      send(res, 200, "text/html; charset=utf-8", fs.readFileSync(EDITOR_PATH));
    } catch (error) {
      sendJson(res, 500, { error: `无法读取编辑器页面：${error.message}` });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/document") {
    try {
      sendJson(res, 200, publicDocument());
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET" && req.url === "/favicon.ico") {
    send(res, 204, "image/x-icon", "");
    return;
  }

  if (req.method === "POST" && req.url === "/api/save") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        const document = saveDocument(JSON.parse(body));
        sendJson(res, 200, { message: "已保存到 index.html", ...document });
      } catch (error) {
        const status = error instanceof EditorError || error instanceof SyntaxError ? 400 : 500;
        sendJson(res, status, { error: error.message });
      }
    });
    return;
  }

  sendJson(res, 404, { error: "页面或接口不存在。" });
});

function openBrowser(url) {
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command);
}

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    const url = `http://${HOST}:${PORT}/`;
    const request = http.get(`${url}api/document`, response => {
      response.resume();
      if (response.statusCode === 200) {
        console.log(`编辑器已经在运行，正在打开：${url}`);
        openBrowser(url);
      } else {
        console.error(`端口 ${PORT} 已被其他程序占用，请关闭占用程序后重试。`);
        process.exitCode = 1;
      }
    });
    request.on("error", () => {
      console.error(`端口 ${PORT} 已被其他程序占用，请关闭占用程序后重试。`);
      process.exitCode = 1;
    });
    return;
  }
  console.error(`无法启动编辑器：${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`表格编辑器已启动：${url}`);
  console.log("关闭此窗口即可停止编辑器。");
  openBrowser(url);
});
