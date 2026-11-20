import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ANGAZA_CLIENT_ID } from '../auth/cognito.jsx';
import { SignInScreen } from '../pages/SignIn.jsx';
import { useAngaza } from './AngazaAuth.jsx';

/**
 * Sign-in for Angaza staff: the school portal's sign-in screen, against the Angaza pool.
 * Only the line under the name differs, so whoever is looking knows which portal this is.
 */
export default function ConsoleSignIn() {
  const { staff, signIn } = useAngaza();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => { document.title = 'Sign in: Angaza Center Console'; }, []);
  if (staff) return <Navigate to="/angaza" replace />;

  return (
    <SignInScreen realm="angaza" subtitle="Angaza Center Console" emailPlaceholder="Enter Angaza email address"
      clientId={ANGAZA_CLIENT_ID}
      wrongAccountHelp="Check that this is your Angaza email. School accounts log in at their school’s page."
      onSignedIn={(tokens, remember) => {
        signIn(tokens, remember);
        navigate(location.state?.from?.pathname || '/angaza', { replace: true });
      }} />
  );
}
