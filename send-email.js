/**
 * Scanoo — Script d'envoi d'emails de prospection
 * Usage: node send-email.js
 * 
 * CREDENTIALS (à mettre à jour si changement de serveur) :
 * - Email : contact.scanoo@gmail.com
 * - App password : ymkkawbaecqqcnwm
 */

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'contact.scanoo@gmail.com',
    pass: 'ymkkawbaecqqcnwm'  // App password Gmail (pas le mot de passe du compte)
  }
});

// Ajouter ici les prospects à démarcher
const prospects = [
  {
    to: 'contact@exemple.fr',
    business: 'Nom du Business',
    score: 55,
    problems: [
      'problème 1 trouvé sur leur site',
      'problème 2',
      'problème 3'
    ]
  }
];

function buildEmail(prospect) {
  const { business, score, problems } = prospect;
  return {
    from: '"Scanoo" <contact.scanoo@gmail.com>',
    to: prospect.to,
    subject: `${business} — Votre site vous fait perdre des clients (score : ${score}/100)`,
    html: `
<div style="font-family: Arial, sans-serif; color: #1E293B; max-width: 600px;">
  <p>Bonjour,</p>
  <p>Je me permets de vous contacter car j'ai analysé le site de <strong>${business}</strong> avec notre outil de diagnostic.</p>
  <p><strong>Votre score : ${score}/100</strong></p>
  <p>Voici ce qu'on a trouvé :</p>
  <ul>${problems.map(p => `<li>${p}</li>`).join('')}</ul>
  <p>Ce sont des problèmes qui font que <strong>vos futurs clients ne vous trouvent pas sur Google</strong>.</p>
  <p>La bonne nouvelle : les corrections sont souvent simples.</p>
  <p><strong>On vous offre un diagnostic complet gratuit</strong> (normalement 49€) — un rapport PDF clair avec les actions concrètes à faire. Zéro jargon.</p>
  <p>Intéressé ? Répondez simplement à cet email.</p>
  <p>Bonne journée,<br>
  <strong>L'équipe Scanoo</strong><br>
  <em>scanoo.fr — Diagnostic de visibilité sur internet pour les pros</em></p>
</div>`
  };
}

async function sendAll() {
  for (let i = 0; i < prospects.length; i++) {
    const p = prospects[i];
    try {
      await transporter.sendMail(buildEmail(p));
      console.log(`✅ ${i+1}/${prospects.length} — ${p.business} (${p.to})`);
    } catch (err) {
      console.error(`❌ Erreur ${p.business}:`, err.message);
    }
    // Pause de 3 secondes entre chaque envoi
    if (i < prospects.length - 1) await new Promise(r => setTimeout(r, 3000));
  }
  console.log('Terminé.');
}

sendAll();
