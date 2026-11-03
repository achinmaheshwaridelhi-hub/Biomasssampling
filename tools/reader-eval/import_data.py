#!/usr/bin/env python3
"""Put training data where the evaluation page (index.html) can see it.

  python3 -I import_data.py zip reader-training-*.zip          # zips from the app's "Download the training set" button
  python3 -I import_data.py folder DIR LABELS.csv --kind weighment [--file-col file] [--value-col checked_value_kg]

zip mode    extracts photos/ into data/photos/, merges labels + digit examples into data/index.json and data/examples.json
folder mode indexes photos where they already are (nothing is copied) using a CSV with a file column and a confirmed-value column
Running it again adds to what is already there (same photo = same entry), so daily zips pile up.
"""
import argparse, csv, io, json, os, re, sys, zipfile
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
INDEX = os.path.join(DATA, 'index.json')
EXAMPLES = os.path.join(DATA, 'examples.json')
SAFE_NAME = re.compile(r'^photos/[A-Za-z0-9_.\-]+\.(jpg|jpeg|png|webp)$')


def load(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def import_zip(paths):
    idx = {s['key']: s for s in load(INDEX, {'samples': []})['samples']}
    ex = load(EXAMPLES, {})
    os.makedirs(os.path.join(DATA, 'photos'), exist_ok=True)
    added = skipped = 0
    for zp in paths:
        with zipfile.ZipFile(zp) as z:
            bad = z.testzip()
            if bad:
                sys.exit('%s is damaged (%s). Download it again.' % (zp, bad))
            names = set(z.namelist())
            rows = list(csv.DictReader(io.StringIO(z.read('labels.csv').decode('utf-8-sig'))))
            zex = json.loads(z.read('examples.json').decode('utf-8')) if 'examples.json' in names else {}
            for r in rows:
                name = r['file']
                if not SAFE_NAME.match(name) or name not in names:
                    skipped += 1
                    continue
                base = os.path.basename(name)
                dest = os.path.join(DATA, 'photos', base)
                if not os.path.exists(dest):
                    with open(dest, 'wb') as f:
                        f.write(z.read(name))
                key = 'z' + r['id']
                if key in idx:
                    continue
                if r['id'] in zex:
                    ex[r['id']] = zex[r['id']]
                idx[key] = {'key': key, 'id': int(r['id']), 'kind': r['kind'], 'value': r['confirmed_value'],
                            'conf': float(r['reader_conf_percent'] or 0), 'status': r['status'],
                            'url': 'data/photos/' + quote(base), 'hasExamples': r['id'] in zex}
                added += 1
    save(INDEX, {'samples': sorted(idx.values(), key=lambda s: s['key'])})
    save(EXAMPLES, ex)
    print('added %d sample(s), skipped %d, total %d' % (added, skipped, len(idx)))


def import_folder(folder, labels, kind, file_col, value_col):
    idx = {s['key']: s for s in load(INDEX, {'samples': []})['samples']}
    added = 0
    with open(labels, encoding='utf-8-sig', newline='') as f:
        for r in csv.DictReader(f):
            name, value = r[file_col], r[value_col]
            p = os.path.join(folder, name)
            if not os.path.isfile(p) or not str(value).strip():
                print('skipped', name)
                continue
            key = 'f:' + os.path.abspath(p)
            rel = os.path.relpath(p, HERE).replace(os.sep, '/')
            idx[key] = {'key': key, 'id': 0, 'kind': kind, 'value': str(value).strip(), 'conf': 0, 'status': 'FOLDER',
                        'url': '/'.join(quote(part) for part in rel.split('/')), 'hasExamples': False}
            added += 1
    save(INDEX, {'samples': sorted(idx.values(), key=lambda s: s['key'])})
    print('indexed %d photo(s) as kind "%s", total %d' % (added, kind, len(idx)))


ap = argparse.ArgumentParser()
sub = ap.add_subparsers(dest='cmd', required=True)
z = sub.add_parser('zip'); z.add_argument('zips', nargs='+')
d = sub.add_parser('folder'); d.add_argument('folder'); d.add_argument('labels'); d.add_argument('--kind', required=True)
d.add_argument('--file-col', default='file'); d.add_argument('--value-col', default='value')
a = ap.parse_args()
if a.cmd == 'zip':
    import_zip(a.zips)
else:
    import_folder(a.folder, a.labels, a.kind, a.file_col, a.value_col)
