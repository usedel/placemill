import { Modal } from 'antd';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * UI-10: the shortcut reference. `?` opens it from anywhere that is not a text
 * field, and the header carries the same entry next to the settings icon.
 *
 * The list only contains shortcuts that actually work — an entry that lied
 * about the behaviour would be worse than no panel at all.
 */
export default function ShortcutsDialog({ open, onClose }: Props) {
  const t = useT();

  const groups = [
    {
      title: t('shortcuts.groupCollection'),
      items: [
        { keys: ['Ctrl', 'N'], label: t('shortcuts.newTask') },
        { keys: ['Ctrl', 'Enter'], label: t('shortcuts.toggleCollector') },
      ],
    },
    {
      title: t('shortcuts.groupTable'),
      items: [
        { keys: ['Ctrl', 'F'], label: t('shortcuts.focusSearch') },
        { keys: ['↑', '↓'], label: t('shortcuts.moveRowFocus') },
        { keys: ['Shift', 'F10'], label: t('shortcuts.rowMenu') },
      ],
    },
    {
      title: t('shortcuts.groupSplit'),
      items: [
        { keys: ['←', '→'], label: t('shortcuts.moveSplit') },
        { keys: ['Shift', '←/→'], label: t('shortcuts.moveSplitFast') },
        { keys: ['Home', 'End'], label: t('shortcuts.splitLimits') },
        { keys: [t('shortcuts.doubleClick')], label: t('shortcuts.resetSplit') },
      ],
    },
    {
      title: t('shortcuts.groupWindow'),
      items: [
        { keys: ['Ctrl', ','], label: t('shortcuts.openSettings') },
        { keys: ['?'], label: t('shortcuts.openHelp') },
        { keys: ['Esc'], label: t('shortcuts.close') },
      ],
    },
  ];

  return (
    <Modal
      title={t('shortcuts.title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={Math.min(420, window.innerWidth - 32)}
      // The trigger button keeps the focus when the panel closes, so keyboard
      // users never land back at the top of the document (UI-10).
      focusTriggerAfterClose
    >
      {groups.map((group) => (
        <div key={group.title} className="shortcut-group">
          <div className="shortcut-group-title">{group.title}</div>
          {group.items.map((item) => (
            <div key={item.label} className="shortcut-row">
              <span className="shortcut-label">{item.label}</span>
              <span className="shortcut-keys">
                {item.keys.map((key) => (
                  <kbd key={key} className="shortcut-key">
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}
