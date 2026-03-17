#!/usr/bin/env tsx

import { Resend } from 'resend';

async function main() {
  const resend = new Resend('re_6cui3wgF_KNZy7GsmePhY5ZEqhcKca8Sj');
  const r = await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: 'approve@casca-archive.org',
    subject: 'Re: The Woodcut Poet of Northeast Brazil',
    text: 'publish',
  });
  console.log('Result:', JSON.stringify(r));
}

main().catch(console.error);
