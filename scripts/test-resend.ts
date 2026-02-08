#!/usr/bin/env tsx

import { Resend } from 'resend';

const resend = new Resend('re_6cui3wgF_KNZy7GsmePhY5ZEqhcKca8Sj');

async function testResend() {
  try {
    console.log('🔍 Testando Resend API...\n');

    // Test 1: Verificar domínios
    console.log('📧 Verificando domínios verificados...');
    try {
      const domains = await resend.domains.list();
      console.log('Domínios:', JSON.stringify(domains, null, 2));
    } catch (error: any) {
      console.log('Erro ao listar domínios:', error.message);
    }

    // Test 2: Tentar enviar email simples
    console.log('\n📨 Tentando enviar email de teste...');
    const result = await resend.emails.send({
      from: 'onboarding@resend.dev', // Email de teste do Resend
      to: 'victoryves@gmail.com',
      subject: 'Teste CASCA - Email Funciona?',
      html: '<h1>Se você recebeu isso, o Resend está funcionando!</h1><p>O problema era o domínio não verificado.</p>',
    });

    console.log('✅ Resultado:', JSON.stringify(result, null, 2));

  } catch (error: any) {
    console.error('❌ Erro:', error.message);
    if (error.response) {
      console.error('Resposta:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

testResend();
