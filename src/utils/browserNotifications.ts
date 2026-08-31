/**
 * Visual/browser notifications only. Audible order feedback on the staff
 * dashboard is handled by spokenAlerts.ts.
 */
export function requestNotificationPermission(): void {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

export function sendBrowserNotification(title: string, bodyText: string): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;

  if (Notification.permission === 'granted') {
    try {
      new Notification(title, {
        body: bodyText,
        icon: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=128&q=80',
      });
    } catch (error) {
      console.warn('Browser notification error:', error);
    }
    return;
  }

  if (Notification.permission === 'default') {
    Notification.requestPermission()
      .then((permission) => {
        if (permission !== 'granted') return;
        try {
          new Notification(title, {
            body: bodyText,
            icon: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?auto=format&fit=crop&w=128&q=80',
          });
        } catch {
          // Some browsers expose Notification but disallow it in this context.
        }
      })
      .catch(() => {});
  }
}
