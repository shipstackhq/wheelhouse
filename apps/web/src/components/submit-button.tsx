import { useFormStatus } from "react-dom";
import { Spinner } from "./spinner";

/**
 * A submit button that shows it is working: while its form's action runs it is disabled (so a second click cannot
 * double-submit) and shows a spinner. Everything else (classes, title, formAction, children) is passed through, so it
 * replaces a plain `<button>` inside a form without changing how it looks at rest.
 */
export function SubmitButton({ children, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button {...rest} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner />
          {children}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
