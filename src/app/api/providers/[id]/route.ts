import ModelRegistry from '@/lib/models/registry';
import { NextRequest } from 'next/server';

export const DELETE = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    if (!id) {
      return Response.json(
        {
          message: 'O ID do provedor é obrigatório.',
        },
        {
          status: 400,
        },
      );
    }

    const registry = new ModelRegistry();
    await registry.removeProvider(id);

    return Response.json(
      {
        message: 'Provedor excluído com sucesso.',
      },
      {
        status: 200,
      },
    );
  } catch (err: any) {
    console.error('An error occurred while deleting provider', err.message);
    return Response.json(
      {
        message: 'Ocorreu um erro.',
      },
      {
        status: 500,
      },
    );
  }
};

export const PATCH = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const body = await req.json();
    const { name, config } = body;
    const { id } = await params;

    if (!id || !name || !config) {
      return Response.json(
        {
          message: 'Campos obrigatórios ausentes.',
        },
        {
          status: 400,
        },
      );
    }

    const registry = new ModelRegistry();

    const updatedProvider = await registry.updateProvider(id, name, config);

    return Response.json(
      {
        provider: updatedProvider,
      },
      {
        status: 200,
      },
    );
  } catch (err: any) {
    console.error('An error occurred while updating provider', err.message);
    return Response.json(
      {
        message: 'Ocorreu um erro.',
      },
      {
        status: 500,
      },
    );
  }
};
