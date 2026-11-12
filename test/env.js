'use strict';

// Lets unit tests import modules that construct a Supabase client at load time
// without a real project. No network calls are made.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
