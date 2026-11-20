import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadKaggleSources, genreNames, KAGGLE_SOURCES } from './kaggle.ts';
import { ReferenceCatalog } from './reference.ts';

const dataDir = path.join(process.cwd(), 'data');

test('every Kaggle row carries its own source tag', () => {
  const rows = loadKaggleSources(dataDir);
  assert.ok(rows.length > 0);
  const bySource: Record<string, number> = {};
  for (const row of rows) {
    assert.ok(row.source, 'a row without a source tag');
    bySource[row.source] = (bySource[row.source] ?? 0) + 1;
  }
  assert.deepEqual(bySource, { KaggleAnimation: 22370, KaggleMovies: 45460 });
});

test('tv_movie_animation.csv is read against its real header', () => {
  const file = path.join(dataDir, 'kaggle/animated-tv/tv_movie_animation.csv');
  const header = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
  // The header is read from the file, never assumed.
  assert.equal(header, 'title,desc,year,genre,certificate,runtime,rating,votes');

  const rows = loadKaggleSources(dataDir);
  const puss = rows.find(r => r.title === 'Puss in Boots: The Last Wish');
  assert.ok(puss, 'expected the first row to load');
  assert.equal(puss.source, 'KaggleAnimation');
  assert.equal(puss.listed_in, 'Animation, Adventure, Comedy');
  assert.equal(puss.release_year, '2022');
  assert.equal(puss.duration, '102 min');
  assert.equal(puss.type, 'Movie');
});

test('the mixed `year` column is stored as-is, never guessed', () => {
  const rows = loadKaggleSources(dataDir).filter(r => r.source === 'KaggleAnimation');
  // The column mixes plain years, open TV ranges and blanks. All are kept
  // verbatim: a range like "2021–" is real data, not a broken year.
  const years = rows.map(r => r.release_year);
  assert.ok(years.some(y => /^\d{4}$/.test(y)), 'expected plain years');
  assert.ok(years.some(y => /^\d{4}–/.test(y)), 'expected open TV ranges');
  assert.ok(years.some(y => y === ''), 'expected blank years');
  // No value is invented and none is dropped from the count.
  assert.equal(years.length, 22370);
});

test('genreNames reads the TMDB python-repr genres', () => {
  assert.equal(
    genreNames("[{'id': 16, 'name': 'Animation'}, {'id': 35, 'name': 'Comedy'}]"),
    'Animation, Comedy',
  );
  assert.equal(genreNames('[]'), '');
  assert.equal(genreNames(''), '');
});

test('movies_metadata.csv: the split records do not break the load', () => {
  const file = path.join(dataDir, 'kaggle/the-movies-dataset/movies_metadata.csv');
  const rawLines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.length > 0);
  const rows = loadKaggleSources(dataDir).filter(r => r.source === 'KaggleMovies');

  // A stray newline inside `overview` splits a record, so the file has more
  // lines than it has records. A reader that trusted the line count would read
  // the columns misaligned; the loader drops those rows instead.
  assert.ok(rawLines.length > rows.length, 'expected the embedded newline to show up');
  // 45,572 physical lines hold 45,460 records: the reader joins the lines of a
  // quoted `overview` back into one record instead of dropping the row.
  assert.equal(rows.length, 45460);

  // Every kept row is whole: no field carries a newline.
  for (const row of rows) {
    assert.doesNotMatch(row.title + row.listed_in + row.release_year + row.duration, /[\n\r]/);
  }
  // A record whose overview spans lines is joined, never dropped and never read
  // misaligned: its own year and runtime come out with it.
  const jupiter = rows.find(r => r.title === "Jupiter's Wife");
  assert.ok(jupiter, 'the multi-line record must load');
  assert.equal(jupiter.release_year, '1995');
  assert.equal(jupiter.duration, '87 min');
  // A continuation fragment (a line that continues an `overview`) never becomes
  // a title: those fragments are short and start with a space.
  for (const row of rows) assert.doesNotMatch(row.title, /^ /);

  // A well-formed record still loads, with its genres decoded.
  const toy = rows.find(r => r.title === 'Toy Story');
  assert.ok(toy);
  assert.equal(toy.listed_in, 'Animation, Comedy, Family');
  assert.equal(toy.release_year, '1995');
  assert.equal(toy.duration, '81 min');
});

test('the loader reads only files under dataDir and never the network', () => {
  // A directory with no Kaggle files yields nothing and throws nothing.
  const empty = fs.mkdtempSync('/tmp/kaggle-empty-');
  try {
    assert.deepEqual(loadKaggleSources(empty), []);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  // The loader and its CSV reader hold no network client at all.
  for (const file of ['kaggle.ts', 'csv.ts']) {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/direk', file), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(|node:https?|require\(['"]https?['"]\)/);
  }
});

test('the reference catalog appends the Kaggle sources without replacing the rest', () => {
  const catalog = new ReferenceCatalog(dataDir, 6);
  const sources = catalog.sources();
  // The four original sources keep their exact counts. Netflix is 8,807 real
  // records: 8,809 data lines minus the 2 continuation lines of a quoted
  // `description`. The old line-based reader counted those fragments as rows.
  assert.equal(sources.Netflix, 8807);
  assert.equal(sources.IMDb, 1000);
  assert.equal(sources.Filipino, 469);
  assert.equal(sources.Statistics, 4380);
  // The Kaggle sources are added on top.
  assert.equal(sources.KaggleAnimation, 22370);
  assert.equal(sources.KaggleMovies, 45460);
  assert.equal(catalog.size, 82486);

  // A search can surface a Kaggle title, and it keeps its source tag.
  const refs = catalog.search('animation', 'Movie', 20);
  assert.ok(refs.some(r => r.source.startsWith('Kaggle')));
  for (const ref of refs) assert.ok(ref.source.length > 0);
});

test('only the two reviewed Kaggle sources are wired in', () => {
  // Datasets 3 and 4 are blocked on a rights review and must not appear here.
  for (const src of KAGGLE_SOURCES) {
    assert.doesNotMatch(src.file, /identification|ghibli/i);
    assert.doesNotMatch(src.name, /identification|ghibli/i);
  }
});

test('no image or video file sits in data/kaggle', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const files = walk(path.join(dataDir, 'kaggle'));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.doesNotMatch(file, /\.(jpe?g|png|webp|gif|mp4|mov|avi|zip|tar|gz)$/i);
  }
});
