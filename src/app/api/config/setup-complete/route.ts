import configManager from '@/lib/config';
import { NextRequest } from 'next/server';

export const POST = async (req: NextRequest) => {
  try {
    configManager.markSetupComplete();

    return Response.json(
      {
        message: 'Configuração marcada como concluída.',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('Error marking setup as complete: ', err);
    return Response.json({ message: 'Ocorreu um erro.' }, { status: 500 });
  }
};
