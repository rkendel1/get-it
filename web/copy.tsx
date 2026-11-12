/** Customer-facing copy shared by the landing page and home. */
import { contract } from "./contract";

export const EXAMPLES = [
  "Organize these invoices.",
  "Build me a website.",
  "Research these competitors.",
  "Clean up my customer database.",
  "Move my application to another server.",
  "Find someone to repair my deck.",
  "Create a presentation from these documents.",
];

/** What get-it can complete end to end today, said plainly. */
export function Availability() {
  return (
    <p className="availability">
      Today we can quote and complete one kind of work end to end: <strong>{contract.title.toLowerCase()}</strong> (reviewing supplier bills before you pay them). For anything else, a person on our team reviews your request and tells you honestly whether and how we can help. Nothing is charged unless you accept a quote.
    </p>
  );
}

