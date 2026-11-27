import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REQUIRED_FILES, runCli } from "../server/lib/cli.mjs";
import { removePluginEntry, stripTrailingSeparators, syncPluginDirectory } from "../server/lib/cli-sync.mjs";

function writeFiles(baseDir, entries) {
  fs.mkdirSync(baseDir, { recursive: true });
  for (const [relPath, content] of Object.entries(entries)) {
    const fullPath = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
}

function makeErr(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test("stripTrailingSeparators, removePluginEntry, and syncPluginDirectory enforce TypeError and boundary guards", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-sync-guards-"));
  try {
    const srcDir = path.join(tmpRoot, "src");
    const destDir = path.join(tmpRoot, "dest");
    const fileSrc = path.join(tmpRoot, "not-a-dir.txt");
    writeFiles(srcDir, { "a.txt": "ok" });
    fs.writeFileSync(fileSrc, "file", "utf8");

    for (const badPath of ["", "   ", null, undefined, 42]) {
      assert.throws(() => stripTrailingSeparators(badPath), TypeError);
      assert.throws(() => removePluginEntry(badPath), TypeError);
      assert.throws(() => syncPluginDirectory(badPath, destDir), TypeError);
      assert.throws(() => syncPluginDirectory(srcDir, badPath), TypeError);
    }
    for (const badFs of [null, [], "bad", 42]) {
      assert.throws(() => removePluginEntry(destDir, badFs), TypeError);
      assert.throws(() => syncPluginDirectory(srcDir, destDir, { fsOps: badFs }), TypeError);
    }
    for (const badOpts of [null, [], "bad", 42]) {
      assert.throws(() => syncPluginDirectory(srcDir, destDir, badOpts), TypeError);
    }
    for (const badFn of [null, {}, "fn", 42]) {
      assert.throws(() => syncPluginDirectory(srcDir, destDir, { removeEntryFn: badFn }), TypeError);
    }

    assert.throws(() => syncPluginDirectory(path.join(tmpRoot, "missing"), destDir), /ENOENT/);
    assert.throws(() => syncPluginDirectory(fileSrc, destDir), /requires srcDir to be a directory/);

    const fsRoot = path.parse(tmpRoot).root;
    assert.throws(() => removePluginEntry(fsRoot), /Refusing to remove filesystem root/);
    assert.throws(() => syncPluginDirectory(srcDir, fsRoot), /Refusing to sync into filesystem root/);

    const extDir = path.join(tmpRoot, "ext");
    const symDest = path.join(tmpRoot, "sym-dest");
    writeFiles(extDir, { "keep.txt": "safe" });
    fs.symlinkSync(extDir, symDest, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => syncPluginDirectory(srcDir, symDest, { removeEntryFn: () => { throw makeErr("EPERM", "locked"); } }),
      /Refusing in-place sync into locked symlinked directory/
    );
    assert.throws(
      () => syncPluginDirectory(srcDir, fileSrc, { removeEntryFn: () => { throw makeErr("EBUSY", "locked"); } }),
      /Refusing in-place sync into non-directory path/
    );

    assert.throws(
      () =>
        removePluginEntry(path.join(tmpRoot, "sym-file"), {
          ...fs,
          lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false }),
          unlinkSync: () => { throw makeErr("EPERM", "EPERM: locked file symlink"); },
          rmdirSync: () => { throw makeErr("ENOTDIR", "ENOTDIR: not a dir"); },
        }),
      /EPERM: locked file symlink/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("syncPluginDirectory performs clean replacement and removes stale files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-sync-clean-"));
  try {
    const srcDir = path.join(tmpRoot, "src");
    const destDir = path.join(tmpRoot, "dest");
    writeFiles(srcDir, { "a.txt": "new-a", "nested/b.txt": "new-b" });
    writeFiles(destDir, { "a.txt": "old-a", "stale.txt": "remove-me", "old-sub/x.txt": "gone" });

    assert.deepEqual(syncPluginDirectory(srcDir, destDir), { mode: "replaced" });
    assert.equal(fs.readFileSync(path.join(destDir, "a.txt"), "utf8"), "new-a");
    assert.equal(fs.readFileSync(path.join(destDir, "nested/b.txt"), "utf8"), "new-b");
    assert.equal(fs.existsSync(path.join(destDir, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(destDir, "old-sub")), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("syncPluginDirectory falls back on EPERM/EBUSY, handles symlinks safely, prunes stale entries, and propagates real errors", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-sync-eperm-"));
  try {
    const srcDir = path.join(tmpRoot, "src");
    const destDir = path.join(tmpRoot, "dest");
    const extTarget = path.join(tmpRoot, "external-target");
    writeFiles(srcDir, { "keep.txt": "updated", "sub/added.txt": "added", "replace-link/fresh.txt": "real-dir" });
    writeFiles(destDir, {
      "keep.txt": "stale-content",
      "stale.txt": "delete-me",
      "stale-unlocked/dead.txt": "delete-dir",
      "stale-locked/dead.txt": "delete-file-keep-locked-dir",
      "stale-parent/locked-child/dead.txt": "delete-file-keep-parent",
    });
    writeFiles(extTarget, { "secret.txt": "untouched" });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(extTarget, path.join(destDir, "replace-link"), linkType);
    fs.symlinkSync(extTarget, path.join(destDir, "stale-link"), linkType);

    const lockedDirs = new Map([
      [path.resolve(path.join(destDir, "stale-locked")), "EBUSY"],
      [path.resolve(path.join(destDir, "stale-parent", "locked-child")), "EPERM"],
      [path.resolve(path.join(destDir, "stale-parent")), "ENOTEMPTY"],
    ]);
    const fsOps = {
      ...fs,
      rmdirSync(target) {
        const code = lockedDirs.get(path.resolve(target));
        if (code) throw makeErr(code, `${code}: locked dir`);
        return fs.rmdirSync(target);
      },
    };
    const res = syncPluginDirectory(srcDir, destDir, {
      fsOps,
      removeEntryFn(target) {
        if (path.resolve(target) === path.resolve(destDir)) throw makeErr("EBUSY", "EBUSY: dir handle active");
        return removePluginEntry(target, fsOps);
      },
    });

    assert.deepEqual(res, { mode: "in-place" });
    assert.equal(fs.readFileSync(path.join(destDir, "keep.txt"), "utf8"), "updated");
    assert.equal(fs.readFileSync(path.join(destDir, "sub/added.txt"), "utf8"), "added");
    assert.equal(fs.lstatSync(path.join(destDir, "replace-link")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(destDir, "replace-link/fresh.txt"), "utf8"), "real-dir");
    assert.equal(fs.existsSync(path.join(destDir, "stale-link")), false);
    assert.equal(fs.readFileSync(path.join(extTarget, "secret.txt"), "utf8"), "untouched");
    assert.equal(fs.existsSync(path.join(destDir, "stale.txt")), false);
    assert.equal(fs.existsSync(path.join(destDir, "stale-unlocked")), false);
    assert.equal(fs.existsSync(path.join(destDir, "stale-locked/dead.txt")), false);
    assert.equal(fs.existsSync(path.join(destDir, "stale-parent/locked-child/dead.txt")), false);

    // File symlink inside destDir must be unlinked before copyFileSync writes replacement
    const fileLinkSrc = path.join(tmpRoot, "file-link-src");
    const fileLinkDest = path.join(tmpRoot, "file-link-dest");
    writeFiles(fileLinkSrc, { "item.txt": "new-file" });
    writeFiles(fileLinkDest, { "item.txt": "placeholder" });
    const events = [];
    const symlinkItemPath = path.resolve(path.join(fileLinkDest, "item.txt"));
    syncPluginDirectory(fileLinkSrc, fileLinkDest, {
      fsOps: {
        ...fs,
        lstatSync(target) {
          if (path.resolve(target) === symlinkItemPath && !events.includes("unlinked")) {
            return { isSymbolicLink: () => true, isDirectory: () => false };
          }
          return fs.lstatSync(target);
        },
        copyFileSync(s, d) {
          events.push("copied");
          return fs.copyFileSync(s, d);
        },
      },
      removeEntryFn(target) {
        if (path.resolve(target) === path.resolve(fileLinkDest)) throw makeErr("EPERM", "locked root");
        if (path.resolve(target) === symlinkItemPath) {
          events.push("unlinked");
          return fs.unlinkSync(target);
        }
        return removePluginEntry(target);
      },
    });
    assert.deepEqual(events, ["unlinked", "copied"]);

    // Propagate unexpected errors from removeEntryFn, pruneStaleDir rmdirSync, and copyFileSync
    assert.throws(
      () => syncPluginDirectory(srcDir, destDir, { removeEntryFn: () => { throw makeErr("EACCES", "EACCES: top"); } }),
      /EACCES: top/
    );
    writeFiles(destDir, { "prune-fail/x.txt": "1" });
    assert.throws(
      () =>
        syncPluginDirectory(srcDir, destDir, {
          fsOps: {
            ...fs,
            rmdirSync: () => { throw makeErr("EACCES", "EACCES: rmdir fail"); },
          },
          removeEntryFn(t) {
            if (path.resolve(t) === path.resolve(destDir)) throw makeErr("EPERM", "locked");
            return removePluginEntry(t);
          },
        }),
      /EACCES: rmdir fail/
    );
    assert.throws(
      () =>
        syncPluginDirectory(srcDir, destDir, {
          fsOps: { ...fs, copyFileSync: () => { throw makeErr("EACCES", "EACCES: real copy failure"); } },
          removeEntryFn: () => { throw makeErr("EPERM", "EPERM: simulated lock"); },
        }),
      /EACCES: real copy failure/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCli unlinks pre-existing symlinks/junctions before writing REQUIRED_FILES and UI bundle", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-cli-ui-sym-"));
  try {
    const bundleDir = path.join(tmpRoot, "bundle");
    const homeDir = path.join(tmpRoot, "home");
    const extUiDir = path.join(tmpRoot, "external-ui");
    writeFiles(extUiDir, { "keep.txt": "safe" });
    for (const f of REQUIRED_FILES) {
      writeFiles(bundleDir, { [f]: f === "package.json" ? JSON.stringify({ version: "1.0.3" }) : `ok:${f}` });
    }
    writeFiles(bundleDir, {
      "server/index.mjs": "// server\n",
      "sidecars/marketplace/sidecar.json": "{}",
      "sidecars/marketplace/server.mjs": "// sidecar\n",
      "ui/dist/marketplace.html": "<html>fresh</html>",
    });

    const targetDir = path.join(homeDir, ".gemini", "config", "plugins", "agy-community-marketplace");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(targetDir, "README.md"), { recursive: true });
    fs.symlinkSync(extUiDir, path.join(targetDir, "ui"), process.platform === "win32" ? "junction" : "dir");

    const res = runCli({
      argv: ["install"],
      rootDir: bundleDir,
      env: { USERPROFILE: homeDir },
      stdout: () => {},
      stderr: () => {},
      installDepsFn: () => {},
    });
    assert.deepEqual(res, { handled: true, exitCode: 0 });
    assert.equal(fs.lstatSync(path.join(targetDir, "ui")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(targetDir, "ui/dist/marketplace.html"), "utf8"), "<html>fresh</html>");
    assert.equal(fs.readFileSync(path.join(targetDir, "README.md"), "utf8"), "ok:README.md");
    assert.equal(fs.readFileSync(path.join(extUiDir, "keep.txt"), "utf8"), "safe");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("syncPluginDirectory overwrites files cleanly while a live child process holds a subdirectory as CWD", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mp-sync-live-"));
  const srcDir = path.join(tmpRoot, "src");
  const destDir = path.join(tmpRoot, "dest");
  const lockedSubdir = path.join(destDir, "marketplace");
  let child;

  try {
    writeFiles(srcDir, { "marketplace/server.mjs": "// v2 sidecar\n", "marketplace/new-mod.mjs": "// added\n" });
    writeFiles(destDir, { "marketplace/server.mjs": "// v1 sidecar\n", "marketplace/stale.mjs": "// old\n", "unlocked-stale.txt": "x" });

    child = spawn(process.execPath, ["-e", 'process.stdout.write("ready\\n"); setTimeout(() => {}, 5000);'], {
      cwd: lockedSubdir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for child readiness")), 3000);
      const onError = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      const onExit = (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Child exited prematurely before readiness (code=${code}, signal=${signal})`));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        resolve();
      });
    });

    const res = syncPluginDirectory(srcDir, destDir);
    assert.equal(res.mode, process.platform === "win32" ? "in-place" : "replaced");
    assert.equal(fs.readFileSync(path.join(lockedSubdir, "server.mjs"), "utf8"), "// v2 sidecar\n");
    assert.equal(fs.readFileSync(path.join(lockedSubdir, "new-mod.mjs"), "utf8"), "// added\n");
    assert.equal(fs.existsSync(path.join(lockedSubdir, "stale.mjs")), false);
    assert.equal(fs.existsSync(path.join(destDir, "unlocked-stale.txt")), false);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
