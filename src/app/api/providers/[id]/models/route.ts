import ModelRegistry from '@/lib/models/registry';
import { Model } from '@/lib/models/types';
import { NextRequest } from 'next/server';

export const POST = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const body: Partial<Model> & { type: 'embedding' | 'chat' } =
      await req.json();

    if (!body.key || !body.name) {
      return Response.json(
        {
          message: 'Chave e nome devem ser fornecidos',
        },
        {
          status: 400,
        },
      );
    }

    const registry = new ModelRegistry();

    await registry.addProviderModel(id, body.type, body);

    return Response.json(
      {
        message: 'Modelo adicionado com sucesso',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('An error occurred while adding provider model', err);
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

export const DELETE = async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  try {
    const { id } = await params;

    const body: { key: string; type: 'embedding' | 'chat' } = await req.json();

    if (!body.key) {
      return Response.json(
        {
          message: 'Chave e nome devem ser fornecidos',
        },
        {
          status: 400,
        },
      );
    }

    const registry = new ModelRegistry();

    await registry.removeProviderModel(id, body.type, body.key);

    return Response.json(
      {
        message: 'Modelo adicionado com sucesso',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('An error occurred while deleting provider model', err);
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
