/**
 * ElevIQ booking backend.
 * Deploy as a Web App (Execute as: Me, Access: Anyone) bound to a Sheet
 * with three tabs: "Slots", "Bookings", "Waitlist". A fourth tab,
 * "ScopeRequests", is created automatically on first use if missing.
 *
 * Slots tab columns:   Date (YYYY-MM-DD) | Time (HH:MM) | Active (TRUE/FALSE)
 * Bookings tab columns (appended by this script):
 *   Timestamp | SlotID | Name | Email | Topic | Via | Agent UA | Verified Bot
 * The last three are attribution fields stamped by the booking gateway
 * (Cloudflare Worker) when an AI agent books; they stay empty for
 * bookings made through the human form on the website.
 * Waitlist tab columns (appended by this script): Timestamp | Name | Email | Topic
 * ScopeRequests tab columns (appended by this script): Timestamp | Name | Company | Email | Website | Use Case | Offer | Lang
 *
 * A slot's ID is Date_Time, e.g. "2025-09-23_14:00". One booking per slot.
 *
 * Bilingual: every request (GET query string or POST body) may carry
 * lang=en|fr. Defaults to 'fr' when absent, to match the original
 * French-only behavior of this script.
 */

const NOTIFY_EMAIL = 'matthias.jung@eleviq.solutions';
const SENDER_NAME = 'Matthias — ElevIQ';

const DEFAULT_SIGNATURE_EN = 'Matthias Jung, Founder & CTO\n' +
  'Eleviq\n' +
  'E-Mail: matthias.jung@eleviq.solutions\n' +
  'Tel: +33 6 27 58 86 14\n' +
  'Website: https://eleviq.solutions\n' +
  'LinkedIn: https://www.linkedin.com/in/jungmatthias/';
const DEFAULT_SIGNATURE_FR = 'Matthias Jung, Fondateur & CTO\n' +
  'Eleviq\n' +
  'E-Mail : matthias.jung@eleviq.solutions\n' +
  'Tél : +33 6 27 58 86 14\n' +
  'Site web : https://eleviq.solutions\n' +
  'LinkedIn : https://www.linkedin.com/in/jungmatthias/';

// Reads SIGNATURE_EN / SIGNATURE_FR from Script Properties (Project Settings
// → Script Properties) so the signature can be edited without a redeploy.
// Falls back to the hardcoded defaults above when a property isn't set.
// Script Properties values are plain text, so literal "\n" is converted to
// a real newline.
function getSignature(lang) {
  var key = lang === 'en' ? 'SIGNATURE_EN' : 'SIGNATURE_FR';
  var fallback = lang === 'en' ? DEFAULT_SIGNATURE_EN : DEFAULT_SIGNATURE_FR;
  var value = PropertiesService.getScriptProperties().getProperty(key);
  return value ? value.replace(/\\n/g, '\n') : fallback;
}

// Bump this string with each code change. Lets anyone confirm which version
// is actually live via a plain GET, without touching the Sheet or sending mail.
const CODE_VERSION = '2026-08-17-signature-fix';

const DAY_NAMES = {
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
};
const MONTH_NAMES = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
};

function normalizeLang(value) {
  return value === 'en' ? 'en' : 'fr';
}

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lang = normalizeLang(e.parameter && e.parameter.lang);
  return jsonResponse({ version: CODE_VERSION, slots: getSlots(ss, lang) });
}

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ success: false, reason: 'bad_request' });
  }

  const lang = normalizeLang(body.lang);

  // Honeypot: bots fill every field, real users never see or fill this one.
  if (body.hp_check) {
    return jsonResponse({ success: true });
  }

  if (body.action === 'book') {
    return jsonResponse(bookSlot(ss, body, lang));
  }
  if (body.action === 'waitlist') {
    return jsonResponse(addToWaitlist(ss, body, lang));
  }
  if (body.action === 'request_scope') {
    return jsonResponse(requestScope(ss, body, lang));
  }
  return jsonResponse({ success: false, reason: 'unknown_action' });
}

function getSlots(ss, lang) {
  const slotsSheet = ss.getSheetByName('Slots');
  const bookingsSheet = ss.getSheetByName('Bookings');

  const takenIds = {};
  const bookingsData = bookingsSheet.getDataRange().getValues();
  for (let i = 1; i < bookingsData.length; i++) {
    const slotId = bookingsData[i][1];
    if (slotId) takenIds[slotId] = true;
  }

  const slotsData = slotsSheet.getDataRange().getValues();
  const slots = [];
  for (let i = 1; i < slotsData.length; i++) {
    const [date, time, active] = slotsData[i];
    if (!date || !time || active === false || active === 'FALSE') continue;
    const dateStr = formatDate(date);
    const timeStr = formatTime(time);
    const id = dateStr + '_' + timeStr;
    slots.push({
      id: id,
      date: dateStr,
      time: timeStr,
      label: formatLabel(dateStr, timeStr, lang),
      taken: !!takenIds[id]
    });
  }
  return slots;
}

function bookSlot(ss, body, lang) {
  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const topic = (body.topic || '').trim();
  const slotId = (body.slotId || '').trim();

  // Attribution fields, present only when the booking gateway forwarded
  // the request on behalf of an AI agent.
  const via = String(body.via || '').trim();
  const agentUa = String(body.agent_ua || '').trim();
  const agentVerified = String(body.agent_verified || '').trim();

  if (!name || !email || !slotId || !isValidEmail(email)) {
    return { success: false, reason: 'invalid_input' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const slots = getSlots(ss, lang);
    const slot = slots.filter(function (s) { return s.id === slotId; })[0];
    if (!slot) return { success: false, reason: 'unknown_slot', slots: slots };
    if (slot.taken) return { success: false, reason: 'taken', slots: slots };

    ss.getSheetByName('Bookings').appendRow([new Date(), slotId, name, email, topic, via, agentUa, agentVerified]);
    SpreadsheetApp.flush();

    const confirmedSlots = getSlots(ss, lang);
    const confirmedSlot = confirmedSlots.filter(function (s) { return s.id === slotId; })[0];
    if (!confirmedSlot || !confirmedSlot.taken) {
      return { success: false, reason: 'write_not_confirmed', slots: confirmedSlots };
    }

    sendBookingEmails(slot, name, email, topic, lang, attributionLabel(via, agentUa, agentVerified, lang));

    return { success: true, label: slot.label, slots: confirmedSlots };
  } finally {
    lock.releaseLock();
  }
}

function addToWaitlist(ss, body, lang) {
  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const topic = (body.topic || '').trim();

  if (!name || !email || !isValidEmail(email)) {
    return { success: false, reason: 'invalid_input' };
  }

  ss.getSheetByName('Waitlist').appendRow([new Date(), name, email, topic]);

  if (lang === 'en') {
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      name: SENDER_NAME,
      subject: 'ElevIQ waitlist signup: ' + name,
      body: 'New waitlist signup.\n\nName: ' + name + '\nEmail: ' + email + '\nTopic: ' + (topic || '—')
    });

    MailApp.sendEmail({
      to: email,
      name: SENDER_NAME,
      subject: 'ElevIQ — you\'re on the waitlist',
      body: 'Hi ' + name + ',\n\n' +
        'Thanks for your interest! All free slots are full right now, ' +
        'but I\'ve added you to the waitlist and will reach out as soon as a new slot opens up.\n\n' +
        'Talk soon,\nMatthias'
    });
  } else {
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      name: SENDER_NAME,
      subject: 'Liste d\'attente ElevIQ : ' + name,
      body: 'Nouvelle inscription en liste d\'attente.\n\nNom : ' + name + '\nEmail : ' + email + '\nSujet : ' + (topic || '—')
    });

    MailApp.sendEmail({
      to: email,
      name: SENDER_NAME,
      subject: 'ElevIQ — vous êtes sur la liste d\'attente',
      body: 'Bonjour ' + name + ',\n\n' +
        'Merci pour votre intérêt ! Tous les créneaux gratuits sont complets pour le moment, ' +
        'mais je vous ai ajouté(e) à la liste d\'attente et je vous recontacterai dès qu\'un nouveau créneau se libère.\n\n' +
        'À très bientôt,\nMatthias'
    });
  }

  return { success: true };
}

function requestScope(ss, body, lang) {
  const name = (body.name || '').trim();
  const company = (body.company || '').trim();
  const email = (body.email || '').trim();
  const website = (body.website || '').trim();
  const useCase = (body.useCase || '').trim();
  const offer = (body.offer || '').trim();

  if (!name || !email || !useCase || !isValidEmail(email)) {
    return { success: false, reason: 'invalid_input' };
  }

  getOrCreateScopeRequestsSheet(ss).appendRow(
    [new Date(), name, company, email, website, useCase, offer, lang]
  );

  sendScopeRequestEmails(name, company, email, website, useCase, offer, lang);

  return { success: true };
}

function getOrCreateScopeRequestsSheet(ss) {
  let sheet = ss.getSheetByName('ScopeRequests');
  if (!sheet) {
    sheet = ss.insertSheet('ScopeRequests');
    sheet.appendRow(['Timestamp', 'Name', 'Company', 'Email', 'Website', 'Use Case', 'Offer', 'Lang']);
  }
  return sheet;
}

function sendScopeRequestEmails(name, company, email, website, useCase, offer, lang) {
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    name: SENDER_NAME,
    subject: 'Scope request: ' + name + (offer ? ' — ' + offer : ''),
    body: 'New scope & pricing request.\n\n' +
      'Offer: ' + (offer || '—') + '\n' +
      'Name: ' + name + '\n' +
      'Company: ' + (company || '—') + '\n' +
      'Email: ' + email + '\n' +
      'Website: ' + (website || '—') + '\n' +
      'Use case: ' + useCase
  });

  if (lang === 'en') {
    MailApp.sendEmail({
      to: email,
      name: SENDER_NAME,
      subject: 'ElevIQ — got your request',
      body: 'Hi ' + name + ',\n\n' +
        'Thank you for your interest in our services and for providing details. I\'ll take a look and follow up by email within 3 business days ' +
        '— either with the detailed scope and pricing, or a couple of questions first.\n\n' +
        'Talk soon,\n' + getSignature('en')
    });
  } else {
    MailApp.sendEmail({
      to: email,
      name: SENDER_NAME,
      subject: 'ElevIQ — votre demande est bien reçue',
      body: 'Bonjour ' + name + ',\n\n' +
        'Merci pour votre intérêt pour nos services et pour ces informations. Je vais regarder ça et revenir vers vous par email sous 3 jours ouvrés ' +
        '— avec le périmètre détaillé et le tarif, ou quelques questions au préalable.\n\n' +
        'À bientôt,\n' + getSignature('fr')
    });
  }
}

// Human-readable attribution line for the notification/confirmation emails,
// e.g. "AI agent (declared: claude · verified bot: AI Assistant)" or
// "website form" when no gateway attribution is present.
function attributionLabel(via, agentUa, agentVerified, lang) {
  if (!via && !agentUa && !agentVerified) {
    return lang === 'en' ? 'website form' : 'formulaire du site';
  }
  const parts = [];
  if (via) parts.push((lang === 'en' ? 'declared: ' : 'déclaré : ') + via);
  if (agentVerified) parts.push((lang === 'en' ? 'verified bot: ' : 'bot vérifié : ') + agentVerified);
  if (!via && !agentVerified && agentUa) parts.push('UA: ' + agentUa);
  const label = lang === 'en' ? 'AI agent' : 'agent IA';
  return parts.length ? label + ' (' + parts.join(' · ') + ')' : label;
}

function sendBookingEmails(slot, name, email, topic, lang, viaLabel) {
  if (lang === 'en') {
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      name: SENDER_NAME,
      subject: 'New booking: ' + slot.label,
      body: 'Name: ' + name + '\nEmail: ' + email + '\nTopic: ' + (topic || '—') + '\nSlot: ' + slot.label +
        '\nBooked via: ' + viaLabel
    });

    MailApp.sendEmail({
      to: email,
      name: SENDER_NAME,
      subject: 'Your ElevIQ slot is confirmed — ' + slot.label,
      body: 'Hi ' + name + ',\n\n' +
        'Your free 30-minute slot with Matthias (ElevIQ) is confirmed:\n\n' +
        slot.label + '\n\n' +
        (topic ? 'Topic you shared: ' + topic + '\n\n' : '') +
        'Booked via: ' + viaLabel + '\n\n' +
        'I\'ll send connection details ahead of the call. ' +
        'If you need to cancel or reschedule, just reply to this email.\n\n' +
        'Talk soon,\n' + getSignature('en')
    });
  } else {
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      name: SENDER_NAME,
      subject: 'Nouvelle réservation : ' + slot.label,
      body: 'Nom : ' + name + '\nEmail : ' + email + '\nSujet : ' + (topic || '—') + '\nCréneau : ' + slot.label +
        '\nRéservé via : ' + viaLabel
    });

    MailApp.sendEmail({
      to: email,
      name: SENDER_NAME,
      subject: 'Confirmation de votre créneau ElevIQ — ' + slot.label,
      body: 'Bonjour ' + name + ',\n\n' +
        'Votre créneau gratuit de 30 minutes avec Matthias (ElevIQ) est confirmé :\n\n' +
        slot.label + '\n\n' +
        (topic ? 'Sujet indiqué : ' + topic + '\n\n' : '') +
        'Réservé via : ' + viaLabel + '\n\n' +
        'Je vous enverrai les détails de connexion avant le rendez-vous. ' +
        'Si vous devez annuler ou déplacer ce créneau, répondez simplement à cet email.\n\n' +
        'À bientôt,\n' + getSignature('fr')
    });
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(value).trim();
}

function formatTime(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(value).trim();
}

function formatLabel(dateStr, timeStr, lang) {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const dayName = DAY_NAMES[lang][d.getDay()];
  const monthName = MONTH_NAMES[lang][d.getMonth()];

  if (lang === 'en') {
    return capitalize(dayName) + ', ' + capitalize(monthName) + ' ' + d.getDate() + ' — ' + timeStr;
  }
  const hourLabel = timeStr.replace(':', 'h');
  return capitalize(dayName) + ' ' + d.getDate() + ' ' + monthName + ' — ' + hourLabel;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
