import { notifications } from '@mantine/notifications';

/** Copies text and says whether it worked, the same way everywhere. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notifications.show({ title: 'Copied to clipboard', message: '', color: 'green', autoClose: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    notifications.show({ title: 'Failed to copy', message, color: 'red', autoClose: 3000 });
  }
}
