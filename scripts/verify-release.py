"""Independent release/record archive check; not a unit or performance test."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'manifest.json').read_text('utf-8'))['version']
assert version == '0.4.0'
archive = root / 'dist' / f'ai-diary-{version}.zip'
sha = lambda data: hashlib.sha256(data).hexdigest()
expected = {
    'ai-diary/main.js': 'main.js',
    'ai-diary/manifest.json': 'manifest.json',
    'ai-diary/styles.css': 'styles.css',
    '安装与使用.md': 'docs/安装与使用.md',
    '测试报告.md': 'docs/测试报告.md',
    'CHANGELOG.md': 'CHANGELOG.md',
}
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert len(bundle.namelist()) == len(expected) and set(bundle.namelist()) == set(expected)
    for name, source in expected.items():
        assert bundle.read(name) == (root / source).read_bytes(), name
        assert not any(marker in bundle.read(name) for marker in [b'test-secret-marker', b'synthetic-key', b'test-vault-namespace'])
    assert json.loads(bundle.read('ai-diary/manifest.json'))['version'] == version
    for name in ['main.js', 'manifest.json', 'styles.css']:
        assert (root / 'dist/ai-diary' / name).read_bytes() == (root / name).read_bytes()
checksums = dict(line.split('  ', 1)[::-1] for line in (root / 'dist/SHA256SUMS.txt').read_text('utf-8').splitlines())
assert checksums[archive.name] == sha(archive.read_bytes())
old = {
    '0.1.0': 'c353eae8f37a37f33ab5c067de9c562ea0724aca536ed78cfb3ce57ce7384006',
    '0.1.1': '001ac1d4e4b6f4a7f86dbd3afd20396d5768f5b64cfc5ef8e1641841d04bca93',
    '0.2.0': '7e1448af57964129f9026e80e99c3038efd3bd89e60c950968cf43360715ff6f',
    '0.2.1': '3fb3353ee2e3f2760fcc88782c21bd272bd906efeb0d5a6d5cfe3cd734eaf246',
    '0.3.0': '0e7ef8cfe5782a4c379c447ec0bfc3d20234843b18abf7e76d76d8599d520ca7',
}
for release, digest in old.items():
    assert sha((root / 'dist' / f'ai-diary-{release}.zip').read_bytes()) == digest
assert sha((root / 'dist/ai-diary-0.2.1-test-records.zip').read_bytes()) == '59217fb65669a33a4ce5ef0baa59516c71449d140d3b543d5b1b3c299754ba4f'
assert sha((root / 'dist/ai-diary-0.3.0-test-records.zip').read_bytes()) == 'ceff97c12ea8265f3249f031bd787558d2f7e8b7eea0b429268974aeedf1ea78'
report = {'passed': True, 'version': version, 'archive': archive.name, 'sha256': sha(archive.read_bytes()),
          'fileCount': len(expected), 'crcPassed': True, 'sourceAndStagingMatch': True,
          'explicitWhitelist': list(expected), 'syntheticSecretMarkersAbsent': True, 'oldArchivesUnchanged': list(old)}
(root / 'test-results/coherent-package-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
print(json.dumps(report, ensure_ascii=False))

if '--records' in sys.argv:
    names = ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'manifest.json', 'styles.css', 'README.md', 'CHANGELOG.md']
    files = [root / name for name in names]
    for folder, pattern in [('src', '*.ts'), ('scripts', '*.ts'), ('scripts', '*.mjs'), ('scripts', '*.py'), ('tests', '*.ts'), ('docs', '*.md')]:
        files.extend((root / folder).rglob(pattern))
    for pattern in ['coherent-*.png', 'coherent-*.json', 'coherent-*.txt']:
        files.extend((root / 'test-results').glob(pattern))
    for folder in ['coherence']:
        files.extend(p for p in (root / 'test-results' / folder).rglob('*') if p.is_file() and p.suffix in ['.json', '.jsonl', '.md', '.csv', '.txt'])
    files = sorted(set(files))
    records = root / 'dist' / f'ai-diary-{version}-test-records.zip'
    with zipfile.ZipFile(records, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for file in files:
            file.resolve().relative_to(root)
            output.write(file, file.relative_to(root).as_posix())
    with zipfile.ZipFile(records) as output:
        assert output.testzip() is None
        assert len(output.namelist()) == len(files)
        for file in files:
            assert output.read(file.relative_to(root).as_posix()) == file.read_bytes()
    record_hash = sha(records.read_bytes())
    (root / 'dist/TEST_RECORDS_SHA256.txt').write_text(f'{record_hash}  {records.name}\n', 'utf-8')
    print(json.dumps({'testRecords': records.name, 'files': len(files), 'crcPassed': True, 'sourceMatch': True, 'sha256': record_hash}))
