/**
 * ElevIQ booking backend.
 * Deploy as a Web App (Execute as: Me, Access: Anyone) bound to a Sheet
 * with three tabs: "Slots", "Bookings", "Waitlist".
 *
 * Slots tab columns:   Date (YYYY-MM-DD) | Time (HH:MM) | Active (TRUE/FALSE)
 * Bookings tab columns (appended by this script): Timestamp | SlotID | Name | Email | Topic
 * Waitlist tab columns (appended by this script): Timestamp | Name | Email | Topic
 *
 * A slot's ID is Date_Time, e.g. "2025-09-23_14:00". One booking per slot.
 */

const NOTIFY_EMAIL = 'matthias.jung@eleviq.solutions';
const SENDER_NAME = 'Matthias — ElevIQ';

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTH_NAMES = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return jsonResponse({ slots: getSlots(ss) });
}

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ success: false, reason: 'bad_request' });
  }

  // Honeypot: bots fill every field, real users never see or fill this one.
  if (body.company) {
    return jsonResponse({ success: true });
  }

  if (body.action === 'book') {
    return jsonResponse(bookSlot(ss, body));
  }
  if (body.action === 'waitlist') {
    return jsonResponse(addToWaitlist(ss, body));
  }
  return jsonResponse({ success: false, reason: 'unknown_action' });
}

function getSlots(ss) {
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
      label: formatLabel(dateStr, timeStr),
      taken: !!takenIds[id]
    });
  }
  return slots;
}

function bookSlot(ss, body) {
  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const topic = (body.topic || '').trim();
  const slotId = (body.slotId || '').trim();

  if (!name || !email || !slotId || !isValidEmail(email)) {
    return { success: false, reason: 'invalid_input' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const slots = getSlots(ss);
    const slot = slots.filter(function (s) { return s.id === slotId; })[0];
    if (!slot) return { success: false, reason: 'unknown_slot', slots: slots };
    if (slot.taken) return { success: false, reason: 'taken', slots: slots };

    ss.getSheetByName('Bookings').appendRow([new Date(), slotId, name, email, topic]);
    SpreadsheetApp.flush();

    const confirmedSlots = getSlots(ss);
    const confirmedSlot = confirmedSlots.filter(function (s) { return s.id === slotId; })[0];
    if (!confirmedSlot || !confirmedSlot.taken) {
      return { success: false, reason: 'write_not_confirmed', slots: confirmedSlots };
    }

    sendBookingEmails(slot, name, email, topic);

    return { success: true, label: slot.label, slots: confirmedSlots };
  } finally {
    lock.releaseLock();
  }
}

function addToWaitlist(ss, body) {
  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const topic = (body.topic || '').trim();

  if (!name || !email || !isValidEmail(email)) {
    return { success: false, reason: 'invalid_input' };
  }

  ss.getSheetByName('Waitlist').appendRow([new Date(), name, email, topic]);

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

  return { success: true };
}

function sendBookingEmails(slot, name, email, topic) {
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    name: SENDER_NAME,
    subject: 'Nouvelle réservation : ' + slot.label,
    body: 'Nom : ' + name + '\nEmail : ' + email + '\nSujet : ' + (topic || '—') + '\nCréneau : ' + slot.label
  });

  MailApp.sendEmail({
    to: email,
    name: SENDER_NAME,
    subject: 'Confirmation de votre créneau ElevIQ — ' + slot.label,
    body: 'Bonjour ' + name + ',\n\n' +
      'Votre créneau gratuit de 30 minutes avec Matthias (ElevIQ) est confirmé :\n\n' +
      slot.label + '\n\n' +
      (topic ? 'Sujet indiqué : ' + topic + '\n\n' : '') +
      'Je vous enverrai les détails de connexion avant le rendez-vous. ' +
      'Si vous devez annuler ou déplacer ce créneau, répondez simplement à cet email.\n\n' +
      'À bientôt,\nMatthias\nhello@eleviq.solutions'
  });
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

function formatLabel(dateStr, timeStr) {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const dayName = DAY_NAMES[d.getDay()];
  const monthName = MONTH_NAMES[d.getMonth()];
  const hourLabel = timeStr.replace(':', 'h');
  return capitalize(dayName) + ' ' + d.getDate() + ' ' + monthName + ' — ' + hourLabel;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
