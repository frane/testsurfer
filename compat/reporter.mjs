// node --test reporter: one JSON line per finished test (suites are
// skipped), for run.mjs to tally.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    if (d.details?.type === 'suite') continue;
    const err = d.details?.error;
    const cause = err?.cause ?? err;
    yield JSON.stringify({
      file: d.file,
      name: d.name,
      status: event.type === 'test:pass' ? (d.skip !== undefined || d.todo !== undefined ? 'skipped' : 'passed') : 'failed',
      error: cause ? String(cause.message ?? cause).split('\n')[0].slice(0, 200) : undefined,
    }) + '\n';
  }
}
