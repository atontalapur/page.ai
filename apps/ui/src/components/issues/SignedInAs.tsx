import { useSession } from '../../context/IssuesContext';

/**
 * Who the tab is signed in as, in the header, when its token is a person's. Renders nothing
 * for the shared token, the mock source, or outside IssuesProvider.
 */
export default function SignedInAs() {
  const session = useSession();
  if (session?.token !== 'personal') return null;

  return (
    <p className="hidden truncate text-sm text-muted-foreground sm:block">
      Signed in as <span className="font-medium text-foreground">{session.name}</span>
    </p>
  );
}
