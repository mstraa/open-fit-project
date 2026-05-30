// Segmented control (.seg) ported from the design. Controlled: the parent owns
// the active value. Each option is a real <button> for keyboard/focus semantics.

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export interface SegProps<T extends string> {
  options: readonly SegOption<T>[] | readonly T[];
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: SegProps<T>) {
  const opts: SegOption<T>[] = (options as readonly (SegOption<T> | T)[]).map((o) =>
    typeof o === "string" ? { value: o, label: o } : o,
  );
  return (
    <div className="seg" role="tablist" aria-label={ariaLabel}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "is-active" : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
