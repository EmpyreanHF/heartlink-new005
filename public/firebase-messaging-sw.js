/* Heart Link: shows alerts while the app is closed.
   Must be served from the same folder as index.html (e.g. https://your-site/firebase-messaging-sw.js). */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyD6x9xwLcl4iPhvBA9_lCsFDaHJyJNyg44",
  authDomain: "love-connect-d9fdb.firebaseapp.com",
  projectId: "love-connect-d9fdb",
  storageBucket: "love-connect-d9fdb.firebasestorage.app",
  messagingSenderId: "978905926948",
  appId: "1:978905926948:web:79fb3e90b1e1a6555437b1"
});
const messaging = firebase.messaging();

// The server sends data-only messages; the app shows its own banner when it is open and focused,
// so this only runs when nobody is looking at the app.
messaging.onBackgroundMessage(payload => {
  const d = payload.data || {};
  if (d.type === 'incall') {          // someone is calling: stays on screen and vibrates until it is tapped or replaced
    return self.registration.showNotification(d.title || 'Heart Link', {
      body: d.body || 'Incoming call', icon: d.icon || undefined, tag: d.tag || d.nid, renotify: true, requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400, 200, 400], actions: [{ action: 'answer', title: 'Answer' }], data: d
    });
  }
  return self.registration.showNotification(d.title || 'Heart Link', {
    body: d.body || '',
    icon: d.icon || undefined,
    tag: d.tag || d.nid,          // same alert never stacks twice
    data: d
  });
});

// Tapping an alert opens the app on that alert (focuses it if it is already open).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { await c.focus(); c.postMessage({ type: 'flc-open', nid: d.nid }); return; }
    }
    return clients.openWindow(new URL('./?nf=' + encodeURIComponent(d.nid || ''), self.registration.scope).href);
  })());
});