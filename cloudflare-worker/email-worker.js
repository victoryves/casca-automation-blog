/**
 * Cloudflare Email Worker
 *
 * Processes incoming emails and forwards approval requests to Vercel webhook
 */

export default {
  async email(message, env, ctx) {
    try {
      console.log('Received email from:', message.from);
      console.log('To:', message.to);
      console.log('Subject:', message.headers.get('subject'));

      // Extract email body
      const reader = message.raw.getReader();
      const decoder = new TextDecoder();
      let emailBody = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        emailBody += decoder.decode(value, { stream: true });
      }

      // Simple text extraction (look for "poste" or "publish" in the body)
      const bodyLower = emailBody.toLowerCase();
      const hasApprovalKeyword = /\b(poste|publish)\b/.test(bodyLower);

      console.log('Has approval keyword:', hasApprovalKeyword);

      if (hasApprovalKeyword) {
        // Forward to Vercel webhook
        const webhookUrl = env.VERCEL_WEBHOOK_URL; // e.g., https://casca-automation-blog.vercel.app/api/webhook/email
        const webhookSecret = env.WEBHOOK_SECRET;

        console.log('Forwarding to webhook:', webhookUrl);

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${webhookSecret}`,
          },
          body: JSON.stringify({
            from: message.from,
            to: message.to,
            subject: message.headers.get('subject'),
            body: emailBody,
            hasApprovalKeyword: true,
          }),
        });

        const result = await response.json();
        console.log('Webhook response:', result);

        if (response.ok) {
          console.log('✓ Article published successfully');
        } else {
          console.error('✗ Webhook failed:', result);
        }
      } else {
        console.log('No approval keyword found, ignoring email');
      }

    } catch (error) {
      console.error('Email Worker error:', error);
    }
  }
};
