// Assemble the mimOE .addon. Pure Node, no dependencies: every node already
// needs Node to build the bundle, so packaging must not add a second runtime.
//
//   node mim/package-addon.js <addonName> <addonVersion> <addonId> <mimName> <mimVersion> <basePath>
//
// Structure cloned field-for-field from a genuine mimik addon: an outer ustar
// tar (./-prefixed entries) holding manifest.json plus one docker-save-format
// image tar per mim. The image's single layer contains exactly index.js, and
// indexFileChecksum is sha256(index.js) — the serverless loader validates it,
// so every byte here matters.
//
// Deterministic: entry mtimes come from SOURCE_DATE_EPOCH (default: the same
// fixed CREATED timestamp the image config uses), so the same source always
// produces the same .addon. The Python implementation this replaces stamped
// `time.time()`, which made every build differ.
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const [addonName, addonVersion, addonId, mimName, mimVersion, basePath] = process.argv.slice(2);
if (!basePath) {
  console.error('usage: node mim/package-addon.js <addonName> <addonVersion> <addonId> <mimName> <mimVersion> <basePath>');
  process.exit(1);
}

const BUILD = 'mim/build';
const CREATED = '2026-01-01T00:00:00.000Z';
const MTIME = Number(process.env.SOURCE_DATE_EPOCH || Math.floor(Date.parse(CREATED) / 1000));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- ustar writer (matches Python tarfile's USTAR_FORMAT byte for byte) ----------
const BLOCK = 512;
const REGTYPE = '0';
const DIRTYPE = '5';

function str(field, len) {
  const b = Buffer.alloc(len);
  b.write(String(field), 0, len, 'utf8');
  return b;
}
// Python's itn(): (digits-1) octal characters, zero padded, then a NUL.
function num(value, len) {
  const b = Buffer.alloc(len);
  b.write(value.toString(8).padStart(len - 1, '0') + '\0', 0, len, 'ascii');
  return b;
}

function header(name, size, mode, type) {
  const h = Buffer.alloc(BLOCK);
  str(name, 100).copy(h, 0);
  num(mode & 0o7777, 8).copy(h, 100);
  num(0, 8).copy(h, 108);                 // uid
  num(0, 8).copy(h, 116);                 // gid
  num(size, 12).copy(h, 124);
  num(MTIME, 12).copy(h, 136);
  h.write('        ', 148, 8, 'ascii');   // checksum placeholder: 8 spaces
  h.write(type, 156, 1, 'ascii');
  // linkname (157..256) stays zero
  h.write('ustar\0', 257, 6, 'ascii');    // magic
  h.write('00', 263, 2, 'ascii');         // version
  // uname (265..296) and gname (297..328) stay empty, as Python leaves them
  // devmajor (329..336) and devminor (337..344) stay NUL. Python's tarfile
  // writes octal zeros there only for CHRTYPE/BLKTYPE entries; for regular
  // files and directories it emits empty strings, i.e. NULs. Byte-compared
  // against the Python implementation this replaces.
  // prefix (345..499) stays zero
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.type === DIRTYPE) {
      // Python appends "/" to a directory name that lacks it.
      const n = e.name.endsWith('/') ? e.name : e.name + '/';
      parts.push(header(n, 0, e.mode ?? 0o755, DIRTYPE));
      continue;
    }
    parts.push(header(e.name, e.data.length, e.mode ?? 0o644, REGTYPE));
    parts.push(e.data);
    const rem = e.data.length % BLOCK;
    if (rem) parts.push(Buffer.alloc(BLOCK - rem));
  }
  parts.push(Buffer.alloc(BLOCK * 2));    // two zero blocks terminate the archive
  let buf = Buffer.concat(parts);
  // Python's tarfile pads the closed archive out to a full RECORDSIZE block
  // (20 * 512). Reproduced so the output matches byte for byte.
  const RECORD = BLOCK * 20;
  const tail = buf.length % RECORD;
  if (tail) buf = Buffer.concat([buf, Buffer.alloc(RECORD - tail)]);
  return buf;
}

// ---------- layer: exactly index.js at the tar root ----------
const indexJs = fs.readFileSync(`${BUILD}/index.js`);
const indexSha = sha256(indexJs);
const containerId = sha256(Buffer.from(`${mimName}-${mimVersion}`));

const layer = makeTar([{ name: 'index.js', data: indexJs }]);
const layerSha = sha256(layer);
const layerId = layerSha;

// ---------- docker config blocks, cloned from the genuine milm-v1 image ----------
const LABELS = {
  'mimik.runtime': 'javascript',
  'mimik.version': mimVersion,
  'mimik.entry': 'index.js',
  'mimik.type': 'sandbox',
};
const RUN_CONFIG = {
  Hostname: '', Domainname: '', User: '',
  AttachStdin: false, AttachStdout: false, AttachStderr: false,
  Tty: false, OpenStdin: false, StdinOnce: false,
  Env: [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'NODE_ENV=production',
  ],
  Cmd: ['node', 'index.js'],
  ArgsEscaped: true, Image: '', Volumes: null,
  WorkingDir: '/app', Entrypoint: null, OnBuild: null,
  Labels: LABELS,
};
const BUILD_CONFIG = JSON.parse(JSON.stringify(RUN_CONFIG));
BUILD_CONFIG.Hostname = containerId;
BUILD_CONFIG.Cmd = ['/bin/sh', '-c', '#(nop) COPY index.js /app/'];

const config = {
  architecture: 'amd64',
  config: RUN_CONFIG,
  container: containerId,
  container_config: BUILD_CONFIG,
  created: CREATED,
  docker_version: '20.10.0',
  history: [{
    created: CREATED,
    created_by: '/bin/sh -c #(nop) COPY index.js /app/',
    comment: 'mimik JavaScript runtime sandbox - built from scratch',
  }],
  os: 'linux',
  rootfs: { type: 'layers', diff_ids: [`sha256:${layerSha}`] },
};
const configBytes = Buffer.from(JSON.stringify(config));
const configName = sha256(configBytes) + '.json';

const legacyJson = Buffer.from(JSON.stringify({
  id: layerId,
  created: CREATED,
  container: containerId,
  container_config: BUILD_CONFIG,
  docker_version: '20.10.0',
  config: RUN_CONFIG,
  architecture: 'amd64',
  os: 'linux',
}));

const innerManifest = Buffer.from(JSON.stringify([{
  Config: configName,
  RepoTags: [`${mimName}:${mimVersion}`],
  Layers: [`${layerId}/layer.tar`],
}]));

// Python wrote this one with json.dumps DEFAULT separators, i.e. ", " and ": ".
// Reproduced literally rather than with JSON.stringify, which is compact.
const repositories = Buffer.from(
  `{"${mimName}": {"${mimVersion}": "${layerId}", "latest": "${layerId}"}}`
);

const image = makeTar([
  { name: '.', type: DIRTYPE, mode: 0o755 },
  { name: configName, data: configBytes },
  { name: 'manifest.json', data: innerManifest },
  { name: 'repositories', data: repositories },
  { name: `${layerId}/VERSION`, data: Buffer.from('1.0') },
  { name: `${layerId}/json`, data: legacyJson },
  { name: `${layerId}/layer.tar`, data: layer },
]);
const imageFile = `${mimName}-${mimVersion}.tar`;

// ---------- outer addon tar, ./-prefixed like the genuine one ----------
const addonManifest = Buffer.from(JSON.stringify({
  name: addonName,
  version: addonVersion,
  id: addonId,
  mims: [{
    name: mimName,
    image: {
      name: mimName,
      file: imageFile,
      indexFileChecksum: `sha256:${indexSha}`,
    },
    // Defaults; per-node role env comes from the .ini override file.
    env: {
      'MCM.BASE_API_PATH': basePath,
      'MCM.MAX_EXECUTION_TIME_SEC': '180',
      'MCM.OTEL_SUPPORT': 'true',
    },
  }],
}, null, 2));

const out = `${BUILD}/${addonName}-${addonVersion}.addon`;
fs.writeFileSync(out, makeTar([
  { name: './', type: DIRTYPE, mode: 0o755 },
  { name: './manifest.json', data: addonManifest },
  { name: `./${imageFile}`, data: image },
]));

console.log(`   ${out} (${fs.statSync(out).size} bytes)`);
console.log(`   mim: ${mimName}:${mimVersion}  index.js sha256: ${indexSha.slice(0, 16)}...`);
console.log(`   external base path: /${addonId.replace(/\./g, '-')}${basePath}`);
