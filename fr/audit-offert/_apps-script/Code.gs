/**
 * ElevIQ — backend "audit offert" (free AI agent-readiness audit).
 *
 * Standalone Apps Script, independent from the booking backend.
 * Deploy as a Web App (Execute as: Me, Access: Anyone).
 *
 * The data lives in a Google Sheet with a single tab: "FreeAudits".
 * Set a Script Property SHEET_ID to that spreadsheet's id (the long string
 * in its URL: docs.google.com/spreadsheets/d/<SHEET_ID>/edit). If the script
 * is instead container-bound (created from the Sheet via Extensions → Apps
 * Script), SHEET_ID can be omitted and the bound spreadsheet is used.
 *
 * FreeAudits tab columns (row 1 is a header, created automatically if missing):
 *   Code | Campagne | Claimed At | Name | Email | Website | Lang
 *
 * You pre-fill one row per available free audit: put a Code (and optionally a
 * Campagne label, free text, for your own tracking). Leave the rest blank.
 * The same Code may appear on several rows — that grants that many audits for
 * that code. Codes are matched case-insensitively and trimmed.
 *
 * On submission the script looks for the first row whose Code matches and
 * whose "Claimed At" is still empty:
 *   - found     -> the row is filled in, a confirmation email goes to the
 *                  requester and a notification to NOTIFY_EMAIL, and the page
 *                  shows "Félicitations !".
 *   - not found -> nothing is written, only a notification goes to
 *                  NOTIFY_EMAIL, and the page shows "Désolé, plus de places".
 *                  An unknown / mistyped code is treated the same way.
 *
 * The signature used in the requester email can be overridden without a
 * redeploy via a Script Property SIGNATURE_FR (literal "\n" becomes a real
 * newline). Otherwise DEFAULT_SIGNATURE_FR is used.
 */

const NOTIFY_EMAIL = 'matthias.jung@eleviq.solutions';
const SENDER_NAME = 'Matthias — ElevIQ';
const SHEET_NAME = 'FreeAudits';

// Bump with each code change so a plain GET tells you which version is live.
const CODE_VERSION = '2026-09-03-audit-offert-v2';

const DEFAULT_SIGNATURE_FR = 'Matthias Jung, Fondateur & CTO\n' +
  'Eleviq\n' +
  'E-Mail : matthias.jung@eleviq.solutions\n' +
  'Tél : +33 6 27 58 86 14\n' +
  'Site web : https://eleviq.solutions\n' +
  'LinkedIn : https://www.linkedin.com/in/jungmatthias/';

function getSignature() {
  const value = PropertiesService.getScriptProperties().getProperty('SIGNATURE_FR');
  return value ? value.replace(/\\n/g, '\n') : DEFAULT_SIGNATURE_FR;
}

function cap(value, max) {
  return String(value || '').trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  return /^https?:\/\/[^\s.]+\.[^\s]{2,}$/i.test(url);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const bound = SpreadsheetApp.getActiveSpreadsheet();
  if (bound) return bound;
  throw new Error('No spreadsheet: set a Script Property SHEET_ID, or bind this script to a Sheet.');
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Code', 'Campagne', 'Claimed At', 'Name', 'Email', 'Website', 'Lang']);
  }
  return sheet;
}

function doGet() {
  return jsonResponse({ version: CODE_VERSION });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ success: false, reason: 'bad_request' });
  }

  // Honeypot: bots fill every field, real users never see this one.
  if (body.hp_check) {
    return jsonResponse({ success: true, claimed: false });
  }

  const name = cap(body.name, 120);
  const email = cap(body.email, 200);
  const website = cap(body.website, 300);
  const code = cap(body.code, 60);

  if (!name || !email || !website || !code || !isValidEmail(email) || !isValidUrl(website)) {
    return jsonResponse({ success: false, reason: 'invalid_input' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = getSpreadsheet();
    const sheet = getOrCreateSheet(ss);
    const data = sheet.getDataRange().getValues();
    const codeNorm = code.toLowerCase();

    for (let i = 1; i < data.length; i++) {
      const rowCode = String(data[i][0] || '').trim().toLowerCase();
      const claimedAt = data[i][2];
      if (rowCode && rowCode === codeNorm && !claimedAt) {
        const rowNum = i + 1;
        const campaign = String(data[i][1] || '');
        // Columns C..G: Claimed At | Name | Email | Website | Lang
        sheet.getRange(rowNum, 3, 1, 5).setValues([[new Date(), name, email, website, 'fr']]);
        SpreadsheetApp.flush();
        sendClaimEmails(name, email, website, code, campaign);
        return jsonResponse({ success: true, claimed: true });
      }
    }

    // No row available for this code (exhausted or unknown code).
    sendNoSlotEmail(name, email, website, code);
    return jsonResponse({ success: true, claimed: false });
  } catch (err) {
    return jsonResponse({ success: false, reason: 'server_error', detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function sendClaimEmails(name, email, website, code, campaign) {
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    name: SENDER_NAME,
    subject: 'Audit offert réclamé : ' + name,
    body: 'Un audit gratuit vient d\'être réclamé.\n\n' +
      'Nom : ' + name + '\n' +
      'Email : ' + email + '\n' +
      'Site web : ' + website + '\n' +
      'Code : ' + code + '\n' +
      'Campagne : ' + (campaign || '—') + '\n\n' +
      'La ligne correspondante dans l\'onglet FreeAudits a été remplie.'
  });

  MailApp.sendEmail({
    to: email,
    name: SENDER_NAME,
    subject: 'ElevIQ — votre audit de préparation aux agents IA est confirmé',
    body: 'Bonjour ' + name + ',\n\n' +
      'C\'est confirmé : vous faites partie des personnes qui bénéficient d\'un audit ' +
      'de préparation aux agents IA offert par ElevIQ.\n\n' +
      'Site web transmis : ' + website + '\n\n' +
      'Prochaine étape : je vais examiner votre site et revenir vers vous par email sous ' +
      '3 jours ouvrés, soit avec les premières observations et la marche à suivre, soit ' +
      'avec quelques questions de cadrage.\n\n' +
      'Si vous avez des éléments de contexte utiles (parcours clients prioritaires, pages ' +
      'clés, objectifs du site), répondez simplement à cet email.\n\n' +
      'À très vite,\n' + getSignature()
  });
}

function sendNoSlotEmail(name, email, website, code) {
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    name: SENDER_NAME,
    subject: 'Audit offert — demande sans place disponible : ' + name,
    body: 'Une demande d\'audit gratuit n\'a pas pu être honorée (aucune place ' +
      'disponible pour ce code, ou code inconnu).\n\n' +
      'Nom : ' + name + '\n' +
      'Email : ' + email + '\n' +
      'Site web : ' + website + '\n' +
      'Code saisi : ' + code + '\n\n' +
      'Rien n\'a été écrit dans l\'onglet FreeAudits. À vous de voir si vous ' +
      'souhaitez recontacter cette personne ou ajouter une place pour ce code.'
  });
}
