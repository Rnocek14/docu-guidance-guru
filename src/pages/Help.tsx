import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Shield } from 'lucide-react';
import { FAQ } from '@/components/landing/FAQ';
import { AuthAwareShell } from '@/components/layout/AuthAwareShell';

function HelpContent({ showBack }: { showBack: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="max-w-4xl mx-auto">
      {showBack && (
        <Button variant="ghost" size="sm" className="gap-1.5 mb-6" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
      )}
      <FAQ />
    </div>
  );
}

export default function Help() {
  return (
    <AuthAwareShell
      title="Help & FAQ"
      authed={<HelpContent showBack={false} />}
      standalone={
        <div className="min-h-screen bg-background text-foreground">
          <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
            <div className="container mx-auto px-4 h-16 flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              <span className="text-lg font-bold">Help & FAQ</span>
            </div>
          </header>
          <main className="container mx-auto px-4 py-8">
            <HelpContent showBack />
          </main>
        </div>
      }
    />
  );
}