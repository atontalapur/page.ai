import { MonitorIcon, MoonIcon, Sun2Icon } from '@solar-icons/react/bold-duotone';
import { useTheme } from '@page/design-system/components/theme-provider';

const options = [
  { value: 'light', label: 'Light theme', Icon: Sun2Icon },
  { value: 'dark', label: 'Dark theme', Icon: MoonIcon },
  { value: 'system', label: 'Match the system theme', Icon: MonitorIcon },
] as const;

/** Light, dark or the system's, as one small segmented control. */
export default function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5"
    >
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={theme === value}
          title={label}
          onClick={() => setTheme(value)}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color] duration-150 ease-out hover:text-foreground aria-pressed:bg-slate-a3 aria-pressed:text-foreground motion-reduce:transition-none"
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
