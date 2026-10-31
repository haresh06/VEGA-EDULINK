  const express = require('express');
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const os = require('os');
  const { execFile, execFileSync } = require('child_process');

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Full CORS & Chrome/Edge Private Network Access (PNA) Support
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin, Access-Control-Request-Private-Network, Access-Control-Request-Method, Access-Control-Request-Headers');
    res.header('Access-Control-Allow-Private-Network', 'true');
    res.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  const PORT = 4000;

  // ============================================================
  // PORTABLE VEGA TOOLCHAIN PATHS
  // ============================================================

  const PACKAGE_ROOT = path.resolve(__dirname, '..');

  const TOOLCHAIN_BIN = path.join(PACKAGE_ROOT, 'compiler', 'bin');
  const GXX_PATH = path.join(TOOLCHAIN_BIN, 'riscv32-vega-elf-g++.exe');
  const OBJCOPY_PATH = path.join(TOOLCHAIN_BIN, 'riscv32-vega-elf-objcopy.exe');
  const SIZE_PATH = path.join(TOOLCHAIN_BIN, 'riscv32-vega-elf-size.exe');

  const VEGA_HARDWARE_ROOT = path.join(PACKAGE_ROOT, 'hardware', '1.1.2');
  const INC_CORE = path.join(VEGA_HARDWARE_ROOT, 'cores', 'arduino');
  const INC_VARIANT = path.join(VEGA_HARDWARE_ROOT, 'variants', 'standard');
  const INC_SYSTEM = path.join(VEGA_HARDWARE_ROOT, 'system', 'include');
  const INC_THEJAS = path.join(VEGA_HARDWARE_ROOT, 'thejas32', 'include');
  const LINK_LDS = path.join(VEGA_HARDWARE_ROOT, 'thejas32', 'link1.lds');
  const PRECOMPILED_CORE_A = path.join(PACKAGE_ROOT, 'core', 'core.a');

  // Library directories
  const BUILTIN_LIBRARIES_DIR = path.join(VEGA_HARDWARE_ROOT, 'libraries');
  const USER_LIBRARIES_DIR = path.join(PACKAGE_ROOT, 'libraries');

  // Ensure user libraries directory exists
  if (!fs.existsSync(USER_LIBRARIES_DIR)) {
    try {
      fs.mkdirSync(USER_LIBRARIES_DIR, { recursive: true });
    } catch {}
  }

  // ============================================================
  // CURATED TRUSTED LIBRARIES REGISTRY
  // ============================================================

  const CURATED_LIBRARIES = {
    SPI: {
      name: 'SPI',
      displayName: 'SPI (Hardware SPI Driver)',
      author: 'C-DAC',
      version: '1.0.0',
      description: 'Hardware SPI communication library for THEJAS32 / VEGA ARIES v2',
      header: 'SPI.h',
      category: 'Communication',
      isLocal: true,
    },
    Wire: {
      name: 'Wire',
      displayName: 'Wire (I2C Master Driver)',
      author: 'C-DAC',
      version: '1.0.0',
      description: 'Hardware I2C / TWI communication library for THEJAS32 / VEGA ARIES v2',
      header: 'Wire.h',
      category: 'Communication',
      isLocal: true,
    },
    MD_MAX72xx: {
      name: 'MD_MAX72xx',
      displayName: 'MD_MAX72xx',
      author: 'MajicDesigns',
      version: '3.5.1',
      description: 'LED Matrix Controller for MAX7219/MAX7221 displays',
      url: 'https://github.com/MajicDesigns/MD_MAX72XX/archive/refs/tags/v3.5.1.zip',
      header: 'MD_MAX72xx.h',
      category: 'Display',
    },
    LiquidCrystal_I2C: {
      name: 'LiquidCrystal_I2C',
      displayName: 'LiquidCrystal I2C',
      author: 'Frank de Brabander / Marco Schwartz',
      version: '1.1.2',
      description: 'I2C LCD controller for HD44780 displays using PCF8574 I2C backpack',
      url: 'https://github.com/marcoschwartz/LiquidCrystal_I2C/archive/refs/tags/1.1.2.zip',
      header: 'LiquidCrystal_I2C.h',
      category: 'Display',
    },
  };

  // ============================================================
  // LIBRARY SCANNING & DEPENDENCY RESOLUTION
  // ============================================================

  function scanAvailableLibraries() {
    const libMap = new Map(); // libName -> { name, rootDir, includeDirs, sourceFiles, headers, type }
    const headerToLibMap = new Map(); // headerLower -> libName

    const roots = [
      { dir: USER_LIBRARIES_DIR, type: 'user' },
      { dir: BUILTIN_LIBRARIES_DIR, type: 'builtin' },
    ];

    for (const { dir: root, type } of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const libName = entry.name;
          if (libMap.has(libName)) continue; // User library overrides builtin

          const libDir = path.join(root, libName);
          const srcDir = path.join(libDir, 'src');
          const utilityDir = path.join(libDir, 'utility');
          const includeDirs = [];
          const sourceFiles = [];
          const headers = [];

          function scanDir(dir, recursive = false) {
            if (!fs.existsSync(dir)) return;
            try {
              const files = fs.readdirSync(dir, { withFileTypes: true });
              for (const file of files) {
                const fullPath = path.join(dir, file.name);
                if (file.isDirectory() && recursive) {
                  scanDir(fullPath, recursive);
                } else if (file.isFile()) {
                  const lower = file.name.toLowerCase();
                  if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx')) {
                    sourceFiles.push(fullPath);
                  } else if (lower.endsWith('.h') || lower.endsWith('.hpp')) {
                    headers.push(file.name);
                    if (!headerToLibMap.has(lower)) {
                      headerToLibMap.set(lower, libName);
                    }
                  }
                }
              }
            } catch {}
          }

          if (fs.existsSync(srcDir)) {
            includeDirs.push(srcDir);
            includeDirs.push(libDir);
            scanDir(srcDir, true);
          } else {
            includeDirs.push(libDir);
            scanDir(libDir, false);
          }

          if (fs.existsSync(utilityDir)) {
            includeDirs.push(utilityDir);
            scanDir(utilityDir, false);
          }

          libMap.set(libName, {
            name: libName,
            type,
            rootDir: libDir,
            includeDirs,
            sourceFiles,
            headers,
          });
        }
      } catch {}
    }

    return { libMap, headerToLibMap };
  }

  function extractIncludes(text) {
    const includes = new Set();
    if (!text || typeof text !== 'string') return includes;
    const regex = /#include\s+[<"]([^>"]+)[>"]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      includes.add(path.basename(match[1]).toLowerCase());
    }
    return includes;
  }

  function resolveUsedLibraries(sourceTexts) {
    const { libMap, headerToLibMap } = scanAvailableLibraries();
    const usedLibNames = new Set();
    const processedLibs = new Set();

    const includeQueue = new Set();
    for (const txt of sourceTexts) {
      const incs = extractIncludes(txt);
      for (const inc of incs) {
        includeQueue.add(inc);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const incHeader of includeQueue) {
        const libName = headerToLibMap.get(incHeader);
        if (libName && !usedLibNames.has(libName)) {
          usedLibNames.add(libName);
          changed = true;
        }
      }

      for (const libName of usedLibNames) {
        if (processedLibs.has(libName)) continue;
        processedLibs.add(libName);

        const libInfo = libMap.get(libName);
        if (libInfo) {
          const allLibFiles = [...libInfo.sourceFiles];
          for (const incDir of libInfo.includeDirs) {
            try {
              if (fs.existsSync(incDir)) {
                const files = fs.readdirSync(incDir);
                for (const f of files) {
                  if (f.toLowerCase().endsWith('.h') || f.toLowerCase().endsWith('.hpp')) {
                    allLibFiles.push(path.join(incDir, f));
                  }
                }
              }
            } catch {}
          }

          for (const fPath of allLibFiles) {
            try {
              if (fs.existsSync(fPath)) {
                const content = fs.readFileSync(fPath, 'utf8');
                const subIncs = extractIncludes(content);
                for (const subInc of subIncs) {
                  if (!includeQueue.has(subInc)) {
                    includeQueue.add(subInc);
                    changed = true;
                  }
                }
              }
            } catch {}
          }
        }
      }
    }

    const includeDirs = [];
    const sourceFiles = [];

    for (const libName of usedLibNames) {
      const libInfo = libMap.get(libName);
      if (libInfo) {
        for (const incDir of libInfo.includeDirs) {
          if (!includeDirs.includes(incDir)) {
            includeDirs.push(incDir);
          }
        }
        for (const src of libInfo.sourceFiles) {
          if (!sourceFiles.includes(src)) {
            sourceFiles.push(src);
          }
        }
      }
    }

    return {
      usedLibraries: Array.from(usedLibNames),
      includeDirs,
      sourceFiles,
    };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  function runCommand(cmd, args, cwd) {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          cwd,
          timeout: 60000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
          });
        }
      );
    });
  }

  function parseSizeOutput(stdout) {
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].trim().split(/\s+/);
      if (parts.length >= 6) {
        return {
          text: parseInt(parts[0], 10) || 0,
          data: parseInt(parts[1], 10) || 0,
          bss: parseInt(parts[2], 10) || 0,
          total: parseInt(parts[3], 10) || 0,
          hex: parts[4] || '',
        };
      }
    }
    return { text: 0, data: 0, bss: 0, total: 0, hex: '' };
  }

  // ============================================================
  // STATUS ENDPOINT
  // ============================================================

  app.get('/status', (req, res) => {
    const compilerExists = fs.existsSync(GXX_PATH);
    const hardwareExists = fs.existsSync(VEGA_HARDWARE_ROOT);
    const coreExists = fs.existsSync(PRECOMPILED_CORE_A);
    const { libMap } = scanAvailableLibraries();

    res.json({
      status: compilerExists && hardwareExists && coreExists ? 'ready' : 'incomplete',
      port: PORT,
      packageRoot: PACKAGE_ROOT,
      compiler: {
        path: GXX_PATH,
        exists: compilerExists,
      },
      hardware: {
        path: VEGA_HARDWARE_ROOT,
        exists: hardwareExists,
      },
      core: {
        path: PRECOMPILED_CORE_A,
        exists: coreExists,
      },
      libraries: {
        userDir: USER_LIBRARIES_DIR,
        builtinDir: BUILTIN_LIBRARIES_DIR,
        available: Array.from(libMap.keys()),
      },
    });
  });

  // ============================================================
  // LIBRARY MANAGEMENT ENDPOINTS
  // ============================================================

  /**
   * GET /libraries - List all available built-in and user-installed libraries
   */
  app.get('/libraries', (req, res) => {
    const { libMap } = scanAvailableLibraries();

    const userLibraries = [];
    const builtinLibraries = [];

    for (const [name, info] of libMap.entries()) {
      const item = {
        name,
        displayName: CURATED_LIBRARIES[name]?.displayName || name,
        author: CURATED_LIBRARIES[name]?.author || (info.type === 'builtin' ? 'VEGA / C-DAC' : 'User'),
        version: CURATED_LIBRARIES[name]?.version || (info.type === 'builtin' ? '1.1.2' : '1.0.0'),
        description: CURATED_LIBRARIES[name]?.description || `${info.type === 'builtin' ? 'Built-in' : 'Installed'} library`,
        type: info.type,
        installed: true,
        headers: info.headers,
      };

      if (info.type === 'user') {
        userLibraries.push(item);
      } else {
        builtinLibraries.push(item);
      }
    }

    // Add curated libraries that are not yet installed
    const curatedCatalog = Object.values(CURATED_LIBRARIES).map((c) => {
      const isInstalled = libMap.has(c.name) && libMap.get(c.name).type === 'user';
      return {
        ...c,
        installed: isInstalled,
        type: 'user',
      };
    });

    res.json({
      success: true,
      userDir: USER_LIBRARIES_DIR,
      builtinDir: BUILTIN_LIBRARIES_DIR,
      userLibraries,
      builtinLibraries,
      curatedCatalog,
    });
  });

  /**
   * POST /libraries/install - Download and install a curated library
   */
  app.post('/libraries/install', async (req, res) => {
    const { name } = req.body;

    if (!name || !CURATED_LIBRARIES[name]) {
      return res.status(400).json({
        success: false,
        error: 'Invalid library. Supported: ' + Object.keys(CURATED_LIBRARIES).join(', '),
      });
    }

    const libraryConfig = CURATED_LIBRARIES[name];
    const targetDir = path.join(USER_LIBRARIES_DIR, libraryConfig.name);

    // Local built-in library (e.g. SPI)
    if (libraryConfig.isLocal || libraryConfig.name === 'SPI' || libraryConfig.name === 'Wire') {
      const sourceDir = path.join(BUILTIN_LIBRARIES_DIR, libraryConfig.name);
      if (!fs.existsSync(sourceDir)) {
        return res.status(404).json({
          success: false,
          error: 'Source library not found at ' + sourceDir,
        });
      }
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.cpSync(sourceDir, targetDir, { recursive: true });
      console.log('[Library Manager] Installed local library ' + libraryConfig.name + ' to ' + targetDir);
      return res.json({
        success: true,
        name: libraryConfig.name,
        displayName: libraryConfig.displayName,
        version: libraryConfig.version,
        targetDir,
        message: libraryConfig.displayName + ' (' + libraryConfig.version + ') installed successfully to ' + targetDir + '.',
      });
    }

    // Check if already installed
    if (fs.existsSync(targetDir)) {
      const headerPath = path.join(targetDir, 'src', libraryConfig.header);
      const rootHeaderPath = path.join(targetDir, libraryConfig.header);
      if (fs.existsSync(headerPath) || fs.existsSync(rootHeaderPath)) {
        return res.json({
          success: true,
          alreadyInstalled: true,
          name: libraryConfig.name,
          targetDir,
          message: libraryConfig.displayName + ' is already installed.',
        });
      }
    }

    let tempDir = null;

    try {
      console.log(`[Library Manager] Downloading ${libraryConfig.displayName} from ${libraryConfig.url}...`);
      tempDir = path.join(os.tmpdir(), 'vega_lib_dl_' + Date.now());
      fs.mkdirSync(tempDir, { recursive: true });

      const zipPath = path.join(tempDir, `${libraryConfig.name}.zip`);
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      // Download archive
      const response = await fetch(libraryConfig.url);
      if (!response.ok) {
        throw new Error(`Failed to download library archive (HTTP ${response.status})`);
      }

      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));
      console.log(`[Library Manager] Downloaded ${arrayBuffer.byteLength} bytes. Extracting...`);

      // Extract archive using native tar or Expand-Archive
      try {
        execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir]);
      } catch {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`]);
      }

      // Locate inner folder
      const entries = fs.readdirSync(extractDir);
      if (entries.length === 0) {
        throw new Error('Downloaded archive was empty.');
      }

      let sourceFolder = path.join(extractDir, entries[0]);
      if (!fs.statSync(sourceFolder).isDirectory()) {
        sourceFolder = extractDir;
      }

      // Move to C:\VEGA-LAB\libraries\<name>\
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      fs.cpSync(sourceFolder, targetDir, { recursive: true });

      console.log(`[Library Manager] Successfully installed ${libraryConfig.displayName} to ${targetDir}`);

      return res.json({
        success: true,
        name: libraryConfig.name,
        displayName: libraryConfig.displayName,
        version: libraryConfig.version,
        targetDir,
        message: `${libraryConfig.displayName} (${libraryConfig.version}) installed successfully.`,
      });
    } catch (error) {
      console.error(`[Library Manager] Installation failed for ${name}:`, error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to install library.',
      });
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  /**
   * DELETE /libraries/:name - Remove a user-installed library
   */
  app.delete('/libraries/:name', (req, res) => {
    const safeName = path.basename(req.params.name);
    const targetDir = path.resolve(USER_LIBRARIES_DIR, safeName);

    // Security Check: Ensure path is strictly inside USER_LIBRARIES_DIR
    if (!targetDir.startsWith(path.resolve(USER_LIBRARIES_DIR))) {
      return res.status(403).json({
        success: false,
        error: 'Permission denied: Cannot delete outside user libraries directory.',
      });
    }

    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({
        success: false,
        error: `Library '${safeName}' is not installed.`,
      });
    }

    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(`[Library Manager] Removed ${safeName} from ${targetDir}`);
      return res.json({
        success: true,
        message: `Library '${safeName}' uninstalled successfully.`,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to uninstall library.',
      });
    }
  });

  // ============================================================
  // COMPILE ENDPOINT
  // ============================================================

  app.post('/compile', async (req, res) => {
    let tmpDir = null;

    try {
      const { files } = req.body;

      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No files provided in compile request.',
          phase: 'validate',
        });
      }

      tmpDir = path.join(os.tmpdir(), 'vega_build_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      fs.mkdirSync(tmpDir, { recursive: true });

      const sourceTexts = [];

      for (const file of files) {
        if (!file.name || typeof file.content !== 'string') continue;
        const safeName = path.basename(file.name);
        let targetName = safeName;
        if (safeName.toLowerCase().endsWith('.ino')) {
          targetName = path.parse(safeName).name + '.cpp';
        }
        fs.writeFileSync(path.join(tmpDir, targetName), file.content, 'utf8');
        sourceTexts.push(file.content);
      }

      // Resolve active libraries and their dependencies
      const { usedLibraries, includeDirs: libIncDirs, sourceFiles: libSources } = resolveUsedLibraries(sourceTexts);

      if (usedLibraries.length > 0) {
        console.log(`Active libraries for compilation: ${usedLibraries.join(', ')}`);
      }

      const userSourceFiles = fs
        .readdirSync(tmpDir)
        .filter((name) => {
          const lower = name.toLowerCase();
          return lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx');
        })
        .map((name) => path.join(tmpDir, name));

      if (userSourceFiles.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No compilable C/C++ source files found.',
          phase: 'compile',
        });
      }

      // ========================================================
      // STEP 1 — COMPILE (User Sources + Library Sources)
      // ========================================================

      const objectFiles = [];
      const compileStdout = [];
      const compileStderr = [];

      const baseCompileFlags = [
        '-c',
        '-O3',
        '-march=rv32im',
        '-mabi=ilp32',
        '-fpeel-loops',
        '-ffunction-sections',
        '-fdata-sections',
        '-fpermissive',
        '-Wno-unused-function',
        '-Wno-unused-variable',
        '-Wno-comment',
        '-Wno-dangling-else',
        '-Wno-unused-but-set-variable',
        '-Wall',
        '-fno-rtti',
        '-fno-exceptions',
        '-DF_CPU=100000000L',
        '-DVEGA_ARIES_V2',
        '-DARDUINO=10819',
        `-I${INC_SYSTEM}`,
        `-I${INC_THEJAS}`,
        `-I${INC_CORE}`,
        `-I${INC_VARIANT}`,
        `-I${tmpDir}`,
        ...libIncDirs.map((d) => `-I${d}`),
        '-include',
        'sys/cdefs.h',
        '-g',
      ];

      // Compile User Sources
      for (const srcPath of userSourceFiles) {
        const safeName = path.basename(srcPath);
        const objName = `user_${path.parse(safeName).name}_${crypto.createHash('md5').update(safeName).digest('hex').slice(0, 4)}.o`;
        const objPath = path.join(tmpDir, objName);

        const args = [...baseCompileFlags, srcPath, '-o', objPath];
        console.log(`Compiling user source: ${safeName}...`);

        const result = await runCommand(GXX_PATH, args, tmpDir);
        if (result.stdout) compileStdout.push(result.stdout);
        if (result.stderr) compileStderr.push(result.stderr);

        if (result.code !== 0) {
          return res.status(422).json({
            success: false,
            phase: 'compile',
            error: `Compilation failed for ${safeName}`,
            stdout: compileStdout.join('\n'),
            stderr: compileStderr.join('\n'),
          });
        }

        objectFiles.push(objPath);
      }

      // Compile Library Sources
      for (const srcPath of libSources) {
        const safeName = path.basename(srcPath);
        const objName = `lib_${path.parse(safeName).name}_${crypto.createHash('md5').update(srcPath).digest('hex').slice(0, 6)}.o`;
        const objPath = path.join(tmpDir, objName);

        const args = [...baseCompileFlags, srcPath, '-o', objPath];
        console.log(`Compiling library source: ${path.basename(path.dirname(srcPath))}/${safeName}...`);

        const result = await runCommand(GXX_PATH, args, tmpDir);
        if (result.stdout) compileStdout.push(result.stdout);
        if (result.stderr) compileStderr.push(result.stderr);

        if (result.code !== 0) {
          return res.status(422).json({
            success: false,
            phase: 'compile',
            error: `Compilation failed for library file ${safeName}`,
            stdout: compileStdout.join('\n'),
            stderr: compileStderr.join('\n'),
          });
        }

        objectFiles.push(objPath);
      }

      // ========================================================
      // STEP 2 — LINK
      // ========================================================

      console.log('Linking VEGA firmware...');

      const elfFile = path.join(tmpDir, 'firmware.elf');
      const binFile = path.join(tmpDir, 'firmware.bin');

      const linkArgs = [
        '-march=rv32im',
        '-mabi=ilp32',
        `-T${LINK_LDS}`,
        '-nostartfiles',
        '-Wl,-N',
        '-Wl,--gc-sections',
        '-Wl,--wrap=malloc',
        '-Wl,--wrap=free',
        '-Wl,--wrap=sbrk',
        ...objectFiles,
        '-nostdlib',
        '-Wl,--start-group',
        PRECOMPILED_CORE_A,
        '-lm',
        '-lstdc++',
        '-lc',
        '-lgloss',
        '-Wl,--end-group',
        '-lgcc',
        '-o',
        elfFile,
      ];

      const linkResult = await runCommand(GXX_PATH, linkArgs, tmpDir);

      if (linkResult.code !== 0) {
        return res.status(422).json({
          success: false,
          phase: 'link',
          error: 'VEGA linking failed',
          stdout: compileStdout.join('\n') + '\n' + linkResult.stdout,
          stderr: compileStderr.join('\n') + '\n' + linkResult.stderr,
        });
      }

      // ========================================================
      // STEP 3 — ELF → BIN
      // ========================================================

      console.log('Generating VEGA .bin...');

      const objcopyArgs = ['-R', '.rel.dyn', '-O', 'binary', elfFile, binFile];
      const objcopyResult = await runCommand(OBJCOPY_PATH, objcopyArgs, tmpDir);

      if (objcopyResult.code !== 0) {
        return res.status(500).json({
          success: false,
          phase: 'objcopy',
          error: 'Failed to generate .bin',
          stderr: objcopyResult.stderr,
        });
      }

      // ========================================================
      // STEP 4 — SIZE
      // ========================================================

      const sizeResult = await runCommand(SIZE_PATH, ['-B', elfFile], tmpDir);
      const size = parseSizeOutput(sizeResult.stdout);

      // ========================================================
      // STEP 5 — READ BIN
      // ========================================================

      const binBuffer = fs.readFileSync(binFile);
      const checksum = crypto.createHash('sha256').update(binBuffer).digest('hex').slice(0, 8).toUpperCase();
      const binaryBase64 = binBuffer.toString('base64');

      console.log(`BUILD SUCCESSFUL — ${binBuffer.length} bytes (Libraries: ${usedLibraries.length > 0 ? usedLibraries.join(', ') : 'none'})`);

      // ========================================================
      // RETURN RESULT
      // ========================================================

      return res.json({
        success: true,
        filename: 'VEGA_ARIES_v2_TEST.bin',
        target: 'VEGA ARIES v2 (THEJAS32)',
        toolchain: 'riscv32-vega-elf-g++ (VEGA GCC 10.1.0)',
        f_cpu: '100000000L',
        binarySize: binBuffer.length,
        binaryBase64,
        checksum,
        size,
        libraries: usedLibraries,
        compiledFiles: userSourceFiles.map((p) => path.basename(p)),
        stdout: [...compileStdout, linkResult.stdout, sizeResult.stdout].filter(Boolean).join('\n'),
        stderr: [...compileStderr, linkResult.stderr].filter(Boolean).join('\n'),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        success: false,
        phase: 'server',
        error: error.message || 'Unknown server error',
      });
    } finally {
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  // ============================================================
  // START SERVER
  // ============================================================

  app.listen(PORT, () => {
    console.log(`VEGA Compile Server running at http://localhost:${PORT}`);
  });
