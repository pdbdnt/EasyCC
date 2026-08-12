const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LEGACY_DATA_FILES = [
  'sessions.json',
  'stages.json',
  'parking-events.log',
  'transitions.log',
  'settings.json',
  'agents.json',
  'tasks.json',
  'presets.json',
  'teams.json',
  'team-instances.json',
  'debug.log'
];

const LEGACY_DATA_DIRECTORIES = ['plan-versions', 'transcripts'];

function pathsEqual(left, right, platform = process.platform, pathRef = path) {
  const normalizedLeft = pathRef.resolve(left);
  const normalizedRight = pathRef.resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function createDataError(message, targetPath, cause) {
  const error = new Error(`${message}: ${targetPath}`, { cause });
  error.code = cause && cause.code;
  error.path = (cause && cause.path) || targetPath;
  return error;
}

function verifyWritableDirectory(directory, {
  fsRef = fs,
  cryptoRef = crypto,
  processRef = process
} = {}) {
  fsRef.mkdirSync(directory, { recursive: true });
  const suffix = cryptoRef.randomBytes(8).toString('hex');
  const probePath = path.join(directory, `.easycc-write-probe-${processRef.pid || 'process'}-${suffix}`);
  let descriptor;
  try {
    descriptor = fsRef.openSync(probePath, 'wx');
    fsRef.writeSync(descriptor, '1');
    if (typeof fsRef.fsyncSync === 'function') fsRef.fsyncSync(descriptor);
  } catch (error) {
    throw createDataError('EasyCC cannot write to its data directory', directory, error);
  } finally {
    if (descriptor !== undefined) {
      try { fsRef.closeSync(descriptor); } catch {}
    }
    try { fsRef.unlinkSync(probePath); } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // A failed probe cleanup should not hide the original write result.
      }
    }
  }
}

function copyFileAtomicNoOverwrite(source, target, {
  fsRef = fs,
  cryptoRef = crypto,
  processRef = process
} = {}) {
  fsRef.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${processRef.pid || 'process'}.${cryptoRef.randomBytes(8).toString('hex')}.tmp`
  );

  try {
    fsRef.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    let descriptor;
    try {
      // Windows rejects fsync on a read-only descriptor.
      descriptor = fsRef.openSync(temporary, 'r+');
      if (typeof fsRef.fsyncSync === 'function') fsRef.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) fsRef.closeSync(descriptor);
    }

    try {
      fsRef.linkSync(temporary, target);
      return 'copied';
    } catch (error) {
      if (error && error.code === 'EEXIST') return 'skipped';
      throw error;
    }
  } finally {
    try { fsRef.unlinkSync(temporary); } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        // A later migration pass can remove or ignore an abandoned temp file.
      }
    }
  }
}

function copyDirectoryMissingEntries(sourceDirectory, targetDirectory, options) {
  const { fsRef = fs } = options || {};
  fsRef.mkdirSync(targetDirectory, { recursive: true });
  let copied = 0;
  let skipped = 0;

  for (const entry of fsRef.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const source = path.join(sourceDirectory, entry.name);
    const target = path.join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      const result = copyDirectoryMissingEntries(source, target, options);
      copied += result.copied;
      skipped += result.skipped;
    } else if (entry.isFile()) {
      const result = copyFileAtomicNoOverwrite(source, target, options);
      if (result === 'copied') copied += 1;
      else skipped += 1;
    }
  }
  return { copied, skipped };
}

function migrateLegacyData(sourceDirectory, targetDirectory, options = {}) {
  const { fsRef = fs, logger = console } = options;
  const result = { copied: 0, skipped: 0, errors: [] };

  if (pathsEqual(sourceDirectory, targetDirectory, options.processRef?.platform, options.pathRef || path)) {
    return result;
  }

  try {
    if (!fsRef.existsSync(sourceDirectory)) return result;
  } catch (error) {
    if (error && error.code === 'ENOENT') return result;
    throw error;
  }

  const migrateItem = (name, isDirectory) => {
    const source = path.join(sourceDirectory, name);
    const target = path.join(targetDirectory, name);
    try {
      if (!fsRef.existsSync(source)) return;
      if (isDirectory) {
        const counts = copyDirectoryMissingEntries(source, target, options);
        result.copied += counts.copied;
        result.skipped += counts.skipped;
      } else {
        const status = copyFileAtomicNoOverwrite(source, target, options);
        result[status] += 1;
      }
    } catch (error) {
      result.errors.push({ name, error });
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[Electron] Could not migrate legacy data item ${name}: ${error.message}`);
      }
    }
  };

  for (const name of LEGACY_DATA_FILES) migrateItem(name, false);
  for (const name of LEGACY_DATA_DIRECTORIES) migrateItem(name, true);
  return result;
}

function configurePackagedData({
  app,
  processRef = process,
  fsRef = fs,
  pathRef = path,
  cryptoRef = crypto,
  logger = console
}) {
  const configured = typeof processRef.env.EASYCC_DATA_DIR === 'string'
    ? processRef.env.EASYCC_DATA_DIR.trim()
    : '';

  if (!app.isPackaged && !configured) return null;

  const dataDir = pathRef.resolve(
    configured || pathRef.join(app.getPath('userData'), 'data')
  );

  verifyWritableDirectory(dataDir, { fsRef, cryptoRef, processRef });
  processRef.env.EASYCC_DATA_DIR = dataDir;

  let migration = { copied: 0, skipped: 0, errors: [] };
  let legacyDataDir = null;
  if (app.isPackaged) {
    legacyDataDir = pathRef.resolve(app.getAppPath(), 'data');
    migration = migrateLegacyData(legacyDataDir, dataDir, {
      fsRef,
      cryptoRef,
      processRef,
      pathRef,
      logger
    });
  }

  if (logger && typeof logger.log === 'function') {
    logger.log(`[Electron] EasyCC data directory: ${dataDir}`);
    if (migration.copied > 0) {
      logger.log(`[Electron] Migrated ${migration.copied} legacy data file(s)`);
    }
  }

  return { dataDir, legacyDataDir, migration };
}

module.exports = {
  LEGACY_DATA_FILES,
  LEGACY_DATA_DIRECTORIES,
  pathsEqual,
  verifyWritableDirectory,
  copyFileAtomicNoOverwrite,
  migrateLegacyData,
  configurePackagedData
};
