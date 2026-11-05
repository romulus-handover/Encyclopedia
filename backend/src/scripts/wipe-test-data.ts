// src/scripts/wipe-test-data.ts
//
// #144 — one-off prerequisite for the #109 reseed. Wipes every row across
// every data table (Postgres side) AND every Supabase Auth user, so the
// reseed issues (#109, #100, and the profile/provider/forum seeding
// issues) start from a genuinely empty database rather than accumulating
// alongside whatever's left from testing #137–#139.
//
// Scope, per explicit confirmation on #144 (not inferred): ALL courses
// (not just the original 9 seed ones — anything created while testing is
// included too), ALL accounts including whoever is running this script,
// via the Supabase Admin API so auth.users/identities/sessions are
// cleaned up properly rather than just deleting the profiles row and
// leaving an orphaned login.
//
// Safety: dry-run by default. Prints exactly what would be deleted and
// exits. Only deletes anything when run with --confirm. Mirrors how
// migrations are run — this is meant to be reviewed and run by hand, not
// executed unattended.
//
//   npm run wipe:test-data            # dry run — prints counts only
//   npm run wipe:test-data -- --confirm   # actually deletes everything
//
// Requires SUPABASE_URL and SUPABASE_SECRET_KEY in .env (the
// secret key, not the publishable key — copy sb_secret_... from
// Supabase Settings > API Keys. Never commit it).

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';
import { AppDataSource } from '../data-source';

// Every data table in the schema (cross-checked against every
// CREATE TABLE in src/migrations). TRUNCATE ... CASCADE below also
// catches anything this list misses via FK, but the list is kept
// explicit and complete so the printed dry-run counts are accurate
// for every table, not just the ones CASCADE happens to reach.
//
// #310 — this list had gone stale: user_badges (#225), learning_paths /
// learning_path_courses / learning_path_enrollments (#224), notifications
// (#229), and bookmarks (#230) were all missing. CASCADE meant the actual
// deletion was never affected — each has an FK back to a table already
// listed here, so TRUNCATE still emptied them — but the dry-run preview
// silently under-reported scope, which defeats the point of a
// review-before-you-confirm safety check. Keep this list in sync with
// src/migrations whenever a new table is added.
const TABLES_TO_WIPE = [
  'profiles',
  'providers',
  'courses',
  'course_modules',
  'course_credits',
  'course_faqs',
  'enrollments',
  'quiz_questions',
  'quiz_options',
  'quiz_submissions',
  'module_notes',
  'forum_posts',
  'activity_events',
  'user_badges',
  'learning_paths',
  'learning_path_courses',
  'learning_path_enrollments',
  'notifications',
  'bookmarks',
];

interface AuthUserSummary {
  id: string;
  email: string | undefined;
}

async function listAllAuthUsers(
  supabaseAdmin: SupabaseClient,
): Promise<AuthUserSummary[]> {
  const users: AuthUserSummary[] = [];
  const perPage = 1000;
  let page = 1;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw error;

    users.push(...data.users.map((u) => ({ id: u.id, email: u.email })));

    if (data.users.length < perPage) break;
    page++;
  }

  return users;
}

async function main() {
  const confirmed = process.argv.includes('--confirm');

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !secretKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env to run this script — ' +
        'the secret key (sb_secret_..., not the publishable key) is required to delete auth users.',
    );
  }

  // { realtime: { transport: ws } } — same fix as SupabaseAuthGuard.
  // supabase-js pulls in a realtime client at construction time
  // regardless of whether this script ever uses realtime features, and
  // Node < 22 has no native WebSocket global for it to fall back to.
  //
  // createClient()'s return type has `any` baked into its generic
  // defaults (typescript-eslint flags this exact construction the same
  // way in the pre-existing SupabaseAuthGuard) — not a real type-safety
  // gap here, just how the library's types are shaped.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const supabaseAdmin: SupabaseClient = createClient(
    supabaseUrl,
    secretKey,
    {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      realtime: { transport: ws as any },
    },
  );

  await AppDataSource.initialize();

  const counts: Record<string, number> = {};
  for (const table of TABLES_TO_WIPE) {
    const result = await AppDataSource.query<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM "${table}"`,
    );
    counts[table] = result[0].count;
  }

  const authUsers = await listAllAuthUsers(supabaseAdmin);

  console.log('#144 — the following will be permanently deleted:\n');
  for (const table of TABLES_TO_WIPE) {
    console.log(`  ${table.padEnd(18)} ${counts[table]}`);
  }
  console.log(`  ${'auth users'.padEnd(18)} ${authUsers.length}`);
  if (authUsers.length > 0) {
    console.log('\n  ' + authUsers.map((u) => u.email ?? u.id).join('\n  '));
  }

  if (!confirmed) {
    console.log(
      '\nDry run only — nothing was deleted. Re-run with --confirm to actually wipe.',
    );
    await AppDataSource.destroy();
    return;
  }

  console.log('\n--confirm passed — deleting now...');

  // Postgres side first. CASCADE is a safety net on top of the explicit
  // table list above — it catches any FK relationship not accounted for
  // by hand, in either reference direction.
  await AppDataSource.query(
    `TRUNCATE TABLE ${TABLES_TO_WIPE.map((t) => `"${t}"`).join(', ')} CASCADE`,
  );
  console.log('Postgres tables truncated.');

  // Supabase Auth side. Deliberately sequential (not Promise.all) so a
  // rate limit or transient failure partway through leaves a legible
  // "deleted N of M" state in the console rather than an unordered
  // scramble of results.
  let deletedCount = 0;
  for (const user of authUsers) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (error) {
      console.error(
        `  Failed to delete ${user.email ?? user.id}: ${error.message}`,
      );
    } else {
      deletedCount++;
    }
  }
  console.log(`Auth users deleted: ${deletedCount}/${authUsers.length}.`);

  console.log('\nDone. Database is empty — ready for the #109 reseed.');
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
