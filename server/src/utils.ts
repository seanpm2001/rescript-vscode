import * as c from "./constants";
import * as childProcess from "child_process";
import * as p from "vscode-languageserver-protocol";
import * as path from "path";
import * as t from "vscode-languageserver-types";
import {
  RequestMessage,
  ResponseMessage,
} from "vscode-languageserver-protocol";
import fs from "fs";
import * as os from "os";

let tempFilePrefix = "rescript_format_file_" + process.pid + "_";
let tempFileId = 0;

export let createFileInTempDir = (extension = "") => {
  let tempFileName = tempFilePrefix + tempFileId + extension;
  tempFileId = tempFileId + 1;
  return path.join(os.tmpdir(), tempFileName);
};

// TODO: races here?
// TODO: this doesn't handle file:/// scheme
export let findProjectRootOfFile = (
  source: p.DocumentUri
): null | p.DocumentUri => {
  let dir = path.dirname(source);
  if (fs.existsSync(path.join(dir, c.bsconfigPartialPath))) {
    return dir;
  } else {
    if (dir === source) {
      // reached top
      return null;
    } else {
      return findProjectRootOfFile(dir);
    }
  }
};

// TODO: races here?
// TODO: this doesn't handle file:/// scheme

// We need to recursively search for bs-platform/{platform}/bsc.exe upward from
// the project's root, because in some setups, such as yarn workspace/monorepo,
// the node_modules/bs-platform package might be hoisted up instead of alongside
// the project root.
// Also, if someone's ever formatting a regular project setup's dependency
// (which is weird but whatever), they'll at least find an upward bs-platform
// from the dependent.
export let findBscNativeOfFile = (
  source: p.DocumentUri
): null | p.DocumentUri => {
  let dir = path.dirname(source);
  // The rescript package's rescript command is a JS wrapper. `rescript format`
  // also invokes another JS wrapper. _That_ JS wrapper ultimately calls the
  // (unexposed) bsc -format anyway.
  let bscNativeReScriptPath = path.join(dir, c.bscNativeReScriptPartialPath);
  let bscNativePath = path.join(dir, c.bscNativePartialPath);

  if (fs.existsSync(bscNativeReScriptPath)) {
    return bscNativeReScriptPath;
  } else if (fs.existsSync(bscNativePath)) {
    return bscNativePath;
  } else if (dir === source) {
    // reached the top
    return null;
  } else {
    return findBscNativeOfFile(dir);
  }
};

// TODO: this doesn't handle file:/// scheme
export let findNodeBuildOfProjectRoot = (
  projectRootPath: p.DocumentUri
): null | { buildPath: p.DocumentUri; isReScript: boolean } => {
  let rescriptNodePath = path.join(projectRootPath, c.rescriptNodePartialPath);
  let bsbNodePath = path.join(projectRootPath, c.bsbNodePartialPath);

  if (fs.existsSync(rescriptNodePath)) {
    return { buildPath: rescriptNodePath, isReScript: true };
  } else if (fs.existsSync(bsbNodePath)) {
    return { buildPath: bsbNodePath, isReScript: false };
  }
  return null;
};

type execResult =
  | {
      kind: "success";
      result: string;
    }
  | {
      kind: "error";
      error: string;
    };
export let formatUsingValidBscNativePath = (
  code: string,
  bscNativePath: p.DocumentUri,
  isInterface: boolean
): execResult => {
  let extension = isInterface ? c.resiExt : c.resExt;
  let formatTempFileFullPath = createFileInTempDir(extension);
  fs.writeFileSync(formatTempFileFullPath, code, {
    encoding: "utf-8",
  });
  try {
    let result = childProcess.execFileSync(bscNativePath, [
      "-color",
      "never",
      "-format",
      formatTempFileFullPath,
    ]);
    return {
      kind: "success",
      result: result.toString(),
    };
  } catch (e) {
    return {
      kind: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // async close is fine. We don't use this file name again
    fs.unlink(formatTempFileFullPath, () => null);
  }
};

export let runAnalysisAfterSanityCheck = (
  filePath: p.DocumentUri,
  args: Array<any>
) => {
  let binaryPath;
  if (fs.existsSync(c.analysisDevPath)) {
    binaryPath = c.analysisDevPath;
  } else if (fs.existsSync(c.analysisProdPath)) {
    binaryPath = c.analysisProdPath;
  } else {
    return null;
  }

  let projectRootPath = findProjectRootOfFile(filePath);
  if (projectRootPath == null) {
    return null;
  }
  let options: childProcess.ExecFileSyncOptions = {
    cwd: projectRootPath,
    maxBuffer: Infinity,
  };
  let stdout = childProcess.execFileSync(binaryPath, args, options);
  return JSON.parse(stdout.toString());
};

export let runAnalysisCommand = (
  filePath: p.DocumentUri,
  args: Array<any>,
  msg: RequestMessage
) => {
  let result = runAnalysisAfterSanityCheck(filePath, args);
  let response: ResponseMessage = {
    jsonrpc: c.jsonrpcVersion,
    id: msg.id,
    result,
  };
  return response;
};

export let getReferencesForPosition = (
  filePath: p.DocumentUri,
  position: p.Position
) =>
  runAnalysisAfterSanityCheck(filePath, [
    "references",
    filePath,
    position.line,
    position.character,
  ]);

export let replaceFileExtension = (filePath: string, ext: string): string => {
  let name = path.basename(filePath, path.extname(filePath));
  return path.format({ dir: path.dirname(filePath), name, ext });
};

export let createInterfaceFileUsingValidBscExePath = (
  filePath: string,
  cmiPath: string,
  bscExePath: p.DocumentUri
): execResult => {
  try {
    let resiString = childProcess.execFileSync(bscExePath, [
      "-color",
      "never",
      cmiPath,
    ]);

    let resiPath = replaceFileExtension(filePath, c.resiExt);
    fs.writeFileSync(resiPath, resiString, { encoding: "utf-8" });

    return {
      kind: "success",
      result: "Interface successfully created.",
    };
  } catch (e) {
    return {
      kind: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

export let runBuildWatcherUsingValidBuildPath = (
  buildPath: p.DocumentUri,
  isRescript: boolean,
  projectRootPath: p.DocumentUri
) => {
  let cwdEnv = {
    cwd: projectRootPath,
  };
  if (process.platform === "win32") {
    /*
      - a node.js script in node_modules/.bin on windows is wrapped in a
        batch script wrapper (there's also a regular binary of the same name on
        windows, but that one's a shell script wrapper for cygwin). More info:
        https://github.com/npm/cmd-shim/blob/c5118da34126e6639361fe9706a5ff07e726ed45/index.js#L1
      - a batch script adds the suffix .cmd to the script
      - you can't call batch scripts through the regular `execFile`:
        https://nodejs.org/api/child_process.html#child_process_spawning_bat_and_cmd_files_on_windows
      - So you have to use `exec` instead, and make sure you quote the path
        (since the path might have spaces), which `execFile` would have done
        for you under the hood
    */
    if (isRescript) {
      return childProcess.exec(`"${buildPath}".cmd build -w`, cwdEnv);
    } else {
      return childProcess.exec(`"${buildPath}".cmd -w`, cwdEnv);
    }
  } else {
    if (isRescript) {
      return childProcess.execFile(buildPath, ["build", "-w"], cwdEnv);
    } else {
      return childProcess.execFile(buildPath, ["-w"], cwdEnv);
    }
  }
};

// Logic for parsing .compiler.log
/* example .compiler.log content:

#Start(1600519680823)

  Syntax error!
  /Users/chenglou/github/reason-react/src/test.res:1:8-2:3

  1 │ let a =
  2 │ let b =
  3 │

  This let-binding misses an expression


  Warning number 8
  /Users/chenglou/github/reason-react/src/test.res:3:5-8

  1 │ let a = j`😀`
  2 │ let b = `😀`
  3 │ let None = None
  4 │ let bla: int = "
  5 │   hi

  You forgot to handle a possible case here, for example:
  Some _


  We've found a bug for you!
  /Users/chenglou/github/reason-react/src/test.res:3:9

  1 │ let a = 1
  2 │ let b = "hi"
  3 │ let a = b + 1

  This has type: string
  Somewhere wanted: int

#Done(1600519680836)
*/

// parser helpers
let pathToURI = (file: string) => {
  return process.platform === "win32" ? `file:\\\\\\${file}` : `file://${file}`;
};
let parseFileAndRange = (fileAndRange: string) => {
  // https://github.com/rescript-lang/rescript-compiler/blob/0a3f4bb32ca81e89cefd5a912b8795878836f883/jscomp/super_errors/super_location.ml#L15-L25
  /* The file + location format can be:
    a/b.res <- fallback, no location available (usually due to bad ppx...)
    a/b.res:10:20
    a/b.res:10:20-21     <- last number here is the end char of line 10
    a/b.res:10:20-30:11
  */
  let regex = /(.+)\:(\d+)\:(\d+)(-(\d+)(\:(\d+))?)?$/;
  /*            ^^ file
                      ^^^ start line
                             ^^^ start character
                                  ^ optional range
                                    ^^^ end line or chararacter
                                            ^^^ end character
  */
  // for the trimming, see https://github.com/rescript-lang/rescript-vscode/pull/71#issuecomment-769160576
  let trimmedFileAndRange = fileAndRange.trim();
  let match = trimmedFileAndRange.match(regex);
  if (match === null) {
    // no location! Though LSP insist that we provide at least a dummy location
    return {
      file: pathToURI(trimmedFileAndRange),
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
  }

  let [
    _source,
    file,
    startLine,
    startChar,
    optionalEndGroup,
    endLineOrChar,
    _colonPlusEndCharOrNothing,
    endCharOrNothing,
  ] = match;

  // language-server position is 0-based. Ours is 1-based. Convert
  // also, our end character is inclusive. Language-server's is exclusive
  let range;
  if (optionalEndGroup == null) {
    let start = {
      line: parseInt(startLine) - 1,
      character: parseInt(startChar),
    };
    range = {
      start: start,
      end: start,
    };
  } else {
    let isSingleLine = endCharOrNothing == null;
    let [endLine, endChar] = isSingleLine
      ? [startLine, endLineOrChar]
      : [endLineOrChar, endCharOrNothing];
    range = {
      start: {
        line: parseInt(startLine) - 1,
        character: parseInt(startChar) - 1,
      },
      end: { line: parseInt(endLine) - 1, character: parseInt(endChar) },
    };
  }
  return {
    file: pathToURI(file),
    range,
  };
};

// main parsing logic
type filesDiagnostics = {
  [key: string]: p.Diagnostic[];
};
type parsedCompilerLogResult = {
  done: boolean;
  result: filesDiagnostics;
};
export let parseCompilerLogOutput = (
  content: string
): parsedCompilerLogResult => {
  type parsedDiagnostic = {
    code: number | undefined;
    severity: t.DiagnosticSeverity;
    tag: t.DiagnosticTag | undefined;
    content: string[];
  };
  let parsedDiagnostics: parsedDiagnostic[] = [];
  let lines = content.split(os.EOL);
  let done = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.startsWith("  We've found a bug for you!")) {
      parsedDiagnostics.push({
        code: undefined,
        severity: t.DiagnosticSeverity.Error,
        tag: undefined,
        content: [],
      });
    } else if (line.startsWith("FAILED:")) {
      // File with a self cycle
      parsedDiagnostics.push({
        code: undefined,
        severity: t.DiagnosticSeverity.Error,
        tag: undefined,
        content: [line],
      });
    } else if (line.startsWith("  Warning number ")) {
      let warningNumber = parseInt(line.slice("  Warning number ".length));
      let tag: t.DiagnosticTag | undefined = undefined;
      switch (warningNumber) {
        case 11:
        case 20:
        case 26:
        case 27:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
        case 38:
        case 39:
        case 60:
        case 66:
        case 67:
        case 101:
          tag = t.DiagnosticTag.Unnecessary;
          break;
        case 3:
          tag = t.DiagnosticTag.Deprecated;
          break;
      }
      parsedDiagnostics.push({
        code: Number.isNaN(warningNumber) ? undefined : warningNumber,
        severity: t.DiagnosticSeverity.Warning,
        tag: tag,
        content: [],
      });
    } else if (line.startsWith("  Syntax error!")) {
      parsedDiagnostics.push({
        code: undefined,
        severity: t.DiagnosticSeverity.Error,
        tag: undefined,
        content: [],
      });
    } else if (line.startsWith("#Start(")) {
      // do nothing for now
    } else if (line.startsWith("#Done(")) {
      done = true;
    } else if (
      line.startsWith("File ") &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith("Warning ")
    ) {
      // OCaml warning: skip
      i++;
    } else if (/^  +([0-9]+| +|\.) (│|┆)/.test(line)) {
      //         ^^ indent
      //           ^^^^^^^^^^^^^^^ gutter
      //                           ^^^^^   separator
      // swallow code display. Examples:
      //   10 │
      //    . │
      //      │
      //   10 ┆
    } else if (line.startsWith("  ")) {
      // part of the actual diagnostics message
      parsedDiagnostics[parsedDiagnostics.length - 1].content.push(
        line.slice(2)
      );
    } else if (line.trim() != "") {
      // We'll assume that everything else is also part of the diagnostics too.
      // Most of these should have been indented 2 spaces; sadly, some of them
      // aren't (e.g. outcome printer printing badly, and certain old ocaml type
      // messages not printing with indent). We used to get bug reports and fix
      // the messages, but that strategy turned out too slow. One day we should
      // revert to not having this branch...
      parsedDiagnostics[parsedDiagnostics.length - 1].content.push(line);
    }
  }

  let result: filesDiagnostics = {};
  parsedDiagnostics.forEach((parsedDiagnostic) => {
    let [fileAndRangeLine, ...diagnosticMessage] = parsedDiagnostic.content;
    let { file, range } = parseFileAndRange(fileAndRangeLine);

    if (result[file] == null) {
      result[file] = [];
    }
    result[file].push({
      severity: parsedDiagnostic.severity,
      tags: parsedDiagnostic.tag === undefined ? [] : [parsedDiagnostic.tag],
      code: parsedDiagnostic.code,
      range,
      source: "ReScript",
      // remove start and end whitespaces/newlines
      message: diagnosticMessage.join("\n").trim() + "\n",
    });
  });

  return { done, result };
};
