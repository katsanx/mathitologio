'use strict'

// ---------------------------------------------------------------------------
// Αυτόματες ενημερώσεις — ΜΟΝΟ σιωπηλές.
//
// Κάθε νέο release κατεβαίνει αυτόματα στο παρασκήνιο και εγκαθίσταται (με επανεκκίνηση) όταν
// ο χρήστης κλείσει την εφαρμογή. Δεν υπάρχει πια κουμπί «Λήψη» / σημαντικές ενημερώσεις.
//
// Το feed ενημερώσεων είναι το ΔΗΜΟΣΙΟ repo `katsanx/mathitologio-releases` (μόνο assets).
// Ο πηγαίος κώδικας μπορεί να είναι private στο `katsanx/mathitologio`. Δεν ενσωματώνεται
// μυστικό στην εφαρμογή. Σε dev ο updater μένει ανενεργός.
// ---------------------------------------------------------------------------

const { autoUpdater } = require('electron-updater')
const { app, Notification } = require('electron')
const log = require('electron-log/main')

// Καταγραφή σε αρχείο (updater.log μέσα στο φάκελο logs του userData) — ώστε κάθε
// ενημέρωση να αφήνει ίχνος: ανίχνευση, σοβαρότητα, MB/ποσοστό λήψης (delta vs πλήρες),
// εγκατάσταση στο κλείσιμο και σφάλματα. Χωρίς αυτό, προβλήματα σαν το κενό token είναι
// αόρατα.
try {
  log.transports.file.level = 'info'
  log.transports.console.level = 'info'
  log.transports.file.fileName = 'updater.log'
} catch (_e) {
  /* no-op */
}

const isDev = !!process.env.VITE_DEV_SERVER_URL

const OWNER = 'katsanx'
const REPO = 'mathitologio-releases'
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // ~6 ώρες

let getWin = () => null
let started = false
let silentDownloading = false // αποφυγή διπλού download
let silentReady = false // σιωπηλή ενημέρωση κατεβασμένη, εκκρεμεί install+relaunch στο κλείσιμο
let installing = false // αποτροπή διπλού quitAndInstall / re-entrancy στο before-quit
let lastState = { state: 'idle' } // τελευταία κατάσταση (για update:getState μετά από navigation)

function send(next) {
  lastState = next
  const win = getWin()
  if (win && !win.isDestroyed()) win.webContents.send('update:status', next)
}

// Εγγενής ειδοποίηση OS (παραμένει στο Κέντρο ενεργειών των Windows και μετά το κλείσιμο).
function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch (_e) {
    /* no-op */
  }
}

function wire() {
  autoUpdater.on('checking-for-update', () => log.info('updater: έλεγχος για ενημέρωση…'))
  autoUpdater.on('update-not-available', (info) =>
    log.info('updater: καμία ενημέρωση (τρέχουσα =', info && info.version, ')')
  )

  autoUpdater.on('update-available', (info) => {
    log.info('updater: βρέθηκε έκδοση', info && info.version)
    // Αν έχει ήδη ξεκινήσει λήψη, αγνόησε επαναλαμβανόμενες ειδοποιήσεις των περιοδικών ελέγχων.
    if (silentDownloading) {
      log.info('updater: λήψη ήδη σε εξέλιξη — αγνοώ')
      return
    }
    // Κατέβασε στο παρασκήνιο· η εγκατάσταση γίνεται στο κλείσιμο.
    silentDownloading = true
    log.info('updater: σιωπηλή λήψη ξεκίνησε στο παρασκήνιο')
    autoUpdater.downloadUpdate().catch((e) => {
      silentDownloading = false // να ξαναδοκιμάσει στον επόμενο έλεγχο
      log.error('updater: silent download', e)
    })
  })

  autoUpdater.on('download-progress', (p) => {
    // Πραγματικά bytes δικτύου: σε differential (delta) λήψη το transferred/total είναι
    // πολύ μικρότερα από το πλήρες installer.
    log.info(
      `updater: λήψη ${Math.round(p.percent || 0)}% — ${(p.transferred / 1048576).toFixed(1)}/${(
        p.total / 1048576
      ).toFixed(1)} MB @ ${((p.bytesPerSecond || 0) / 1048576).toFixed(2)} MB/s`
    )
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('updater: η λήψη ολοκληρώθηκε —', info && info.version)
    // Θα εγκατασταθεί ΚΑΙ θα επανεκκινήσει στο κλείσιμο (βλ. before-quit hook), ώστε ο χρήστης
    // να μη χρειάζεται να την ανοίξει χειροκίνητα μέσα στο παράθυρο εγκατάστασης.
    silentReady = true
    log.info('updater: σιωπηλή έτοιμη — install+relaunch στο κλείσιμο')
    send({ state: 'silent-ready', importance: 'silent', version: info.version })
    notify(
      'Ενημέρωση Μαθητολογίου έτοιμη',
      'Θα εφαρμοστεί όταν κλείσετε την εφαρμογή και θα ανοίξει ξανά μόνη της. Μετά το κλείσιμο μην την ανοίξετε εσείς — περιμένετε λίγο.'
    )
  })

  autoUpdater.on('error', (err) => {
    log.error('updater: ΣΦΑΛΜΑ', err && err.stack ? err.stack : err)
  })
}

function init(winGetter) {
  getWin = typeof winGetter === 'function' ? winGetter : () => null

  if (isDev) {
    log.info('updater: παράλειψη (dev)')
    return
  }
  if (started) return
  started = true

  autoUpdater.logger = log
  log.info(`updater: init — feed ${OWNER}/${REPO} (public assets), χωρίς token, ενεργός`)
  autoUpdater.autoDownload = false
  // ΟΧΙ autoInstallOnAppQuit: τη σιωπηλή εγκατάσταση στο κλείσιμο την κάνουμε εμείς ΜΕ
  // επανεκκίνηση (before-quit hook → quitAndInstall), ώστε ο χρήστης να μη χρειάζεται να ανοίξει
  // χειροκίνητα την εφαρμογή μέσα στο παράθυρο εγκατάστασης (race → «ffmpeg.dll δεν βρέθηκε»).
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false // stable: μόνο κανονικά releases
  // Το differential (delta) download παραμένει ΕΝΕΡΓΟ: το feed είναι δημόσιο, ώστε οι
  // ενημερώσεις να μεταφέρουν μόνο το delta κώδικα (το ~300MB LibreOffice δεν ξανακατεβαίνει).
  try {
    autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, private: false })
  } catch (e) {
    console.error('updater: setFeedURL', e)
  }

  // Σιωπηλή ενημέρωση: εγκατάσταση + επανεκκίνηση όταν ο χρήστης κλείσει την εφαρμογή. Έτσι δεν
  // υπάρχει «κενό» στο οποίο ο χρήστης θα άνοιγε χειροκίνητα ημιεγκατεστημένα αρχεία. Ειδοποίηση
  // ότι θα ανοίξει ξανά μόνη της. Το `installing` αποτρέπει re-entrancy (το quitAndInstall
  // ξαναπυροδοτεί before-quit).
  app.on('before-quit', (e) => {
    if (!silentReady || installing) return
    installing = true
    e.preventDefault()
    log.info('updater: quitAndInstall (silent + relaunch) στο κλείσιμο')
    notify('Εγκαθίσταται ενημέρωση', 'Η εφαρμογή θα ανοίξει ξανά μόνη της σε λίγο — μην την ανοίξετε εσείς.')
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, true) // σιωπηλή εγκατάσταση + επανεκκίνηση
      } catch (err) {
        log.error('updater: quitAndInstall silent', err)
        app.quit() // fallback: κανονικό κλείσιμο (το installing=true αποτρέπει loop)
      }
    }, 700)
  })

  wire()

  checkNow(false) // έλεγχος στην εκκίνηση
  setInterval(() => checkNow(false), CHECK_INTERVAL_MS)
}

// force=true → χειροκίνητος έλεγχος από τις Ρυθμίσεις (μόνο για το log).
function checkNow(force) {
  if (!started) {
    log.info('updater: checkNow αλλά ο updater δεν είναι ενεργός')
    return
  }
  log.info('updater: checkNow (force =', !!force, ')')
  autoUpdater.checkForUpdates().catch((e) => log.error('updater: checkForUpdates', e))
}

function getState() {
  return lastState
}

module.exports = { init, checkNow, getState }
