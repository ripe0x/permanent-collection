// Ponder 0.16 serves its HTTP API from a Hono app exported here. The built-in
// `graphql()` middleware exposes the indexed tables; we mount it at both `/`
// and `/graphql`. The app's indexer client (app/lib/data/indexer-client.ts)
// POSTs to the root URL with no path, so the `/` mount is what it hits.
//
// Ponder reserves `/health` and `/ready` (auto-mounted by the framework) — do
// not redeclare them here.

import {db} from 'ponder:api';
import schema from 'ponder:schema';
import {graphql} from 'ponder';
import {Hono} from 'hono';

const app = new Hono();

app.use('/graphql', graphql({db, schema}));
app.use('/', graphql({db, schema}));

export default app;
