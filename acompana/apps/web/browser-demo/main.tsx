/** Versión navegador de Acompaña: las mismas pantallas de apps/web con un backend en memoria. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Login from '../app/page';
import BecarioLayout from '../app/becario/layout';
import BecarioHome from '../app/becario/page';
import BecarioPlan from '../app/becario/plan/page';
import BecarioKit from '../app/becario/kit/page';
import BecarioChat from '../app/becario/chat/page';
import Onboarding from '../app/becario/onboarding/page';
import PanelLayout from '../app/panel/layout';
import PanelHome from '../app/panel/page';
import PanelAlerts from '../app/panel/alertas/page';
import ScholarDetail from '../app/panel/becario/[id]/page';
import { setSession } from '../lib/api';
import { resetDemo, storageStatus } from './backend';
import { navigate, usePath } from './shims/router';

const BECARIO: Record<string, () => JSX.Element | null> = {
  '/becario': BecarioHome,
  '/becario/plan': BecarioPlan,
  '/becario/kit': BecarioKit,
  '/becario/chat': BecarioChat,
  '/becario/onboarding': Onboarding,
};

function Screen({ path }: { path: string }) {
  if (path.startsWith('/becario')) {
    const Page = BECARIO[path] ?? BecarioHome;
    return (
      <BecarioLayout>
        <Page />
      </BecarioLayout>
    );
  }
  if (path.startsWith('/panel')) {
    const Page = path.startsWith('/panel/becario/') ? ScholarDetail : path === '/panel/alertas' ? PanelAlerts : PanelHome;
    return (
      <PanelLayout>
        <Page key={path} />
      </PanelLayout>
    );
  }
  return <Login />;
}

function DemoBar() {
  const [asking, setAsking] = useState(false);
  const saved = storageStatus().persisted;
  return (
    <div className="demobar">
      <span>
        Versión de prueba en el navegador · datos 100&nbsp;% sintéticos · asistente en modo simulado.
        {saved ? ' Tus cambios se guardan solo en este navegador.' : ' Este navegador no permite guardar: los cambios se pierden al recargar.'}
      </span>
      {asking ? (
        <span className="row">
          <span>¿Borrar tus cambios y volver al inicio?</span>
          <button
            onClick={() => {
              resetDemo();
              setSession(null);
              setAsking(false);
              navigate('/');
            }}
          >
            Sí, reiniciar
          </button>
          <button className="secondary" onClick={() => setAsking(false)}>Cancelar</button>
        </span>
      ) : (
        <button className="secondary" onClick={() => setAsking(true)}>Reiniciar demo</button>
      )}
    </div>
  );
}

function App() {
  const path = usePath();
  return (
    <>
      <DemoBar />
      <Screen key={path.split('/')[1]} path={path} />
    </>
  );
}

// Al cargar se empieza en la pantalla de acceso.
setSession(null);
createRoot(document.getElementById('root')!).render(<App />);
