import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { User, Session, AuthError } from '@supabase/supabase-js';
import { supabase, SUPABASE_FUNCTIONS_URL } from '@/integrations/supabase/client';
import type { Profile, AppRole } from '@/lib/types';
import { submitFingerprint } from '@/lib/fingerprint';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  roles: AppRole[];
  isLoading: boolean;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: AuthError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
  hasRole: (role: AppRole) => boolean;
  hasAnyRole: (roles: AppRole[]) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Stable function to load user data
  const loadUserData = useCallback(async (userId: string): Promise<{ profile: Profile | null; roles: AppRole[] }> => {
    try {
      const [profileRes, rolesRes] = await Promise.all([
        supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle(),
        supabase.from('user_roles').select('role').eq('user_id', userId),
      ]);
      
      return {
        profile: profileRes.data as Profile | null,
        roles: (rolesRes.data || []).map((r) => r.role as AppRole),
      };
    } catch (error) {
      console.error('Failed to load user data:', error);
      return { profile: null, roles: [] };
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    const initialize = async () => {
      try {
        // Get current session
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        
        if (!isMounted) return;

        if (currentSession?.user) {
          setSession(currentSession);
          setUser(currentSession.user);
          
          const userData = await loadUserData(currentSession.user.id);
          
          if (isMounted) {
            setProfile(userData.profile);
            setRoles(userData.roles);
          }
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    initialize();

    // Listen for auth changes AFTER initial load
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        if (!isMounted) return;
        
        // Skip initial session event - we handle it above
        if (event === 'INITIAL_SESSION') return;

        console.log('Auth event:', event);

        if (newSession?.user) {
          setSession(newSession);
          setUser(newSession.user);
          
          // Use setTimeout to avoid potential Supabase deadlock
          setTimeout(async () => {
            if (!isMounted) return;
            const userData = await loadUserData(newSession.user.id);
            if (isMounted) {
              setProfile(userData.profile);
              setRoles(userData.roles);
            }
            
            // Collect device fingerprint on sign-in (non-blocking)
            if (event === 'SIGNED_IN' && newSession.access_token) {
              submitFingerprint(
                SUPABASE_FUNCTIONS_URL.replace('/functions/v1', ''),
                newSession.access_token
              ).catch(err => console.warn('Fingerprint collection failed:', err));
            }
          }, 0);
        } else {
          setSession(null);
          setUser(null);
          setProfile(null);
          setRoles([]);
        }
      }
    );

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [loadUserData]);

  const signUp = async (email: string, password: string, fullName?: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: { full_name: fullName },
      },
    });
    return { error };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setRoles([]);
  };

  const hasRole = (role: AppRole) => roles.includes(role);
  const hasAnyRole = (checkRoles: AppRole[]) => checkRoles.some((role) => roles.includes(role));

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        roles,
        isLoading,
        signUp,
        signIn,
        signOut,
        hasRole,
        hasAnyRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
