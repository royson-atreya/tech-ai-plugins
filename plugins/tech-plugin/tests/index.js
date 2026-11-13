// Entry point for `node --test tests/`: recent Node versions treat a folder
// argument as one file to run, which loads this index. It loads every suite.
import('./guard-tests.mjs');
import('./doctor-tests.mjs');
import('./breakdown-tests.mjs');
import('./map-tests.mjs');
import('./document-tests.mjs');
import('./diagram-tests.mjs');
