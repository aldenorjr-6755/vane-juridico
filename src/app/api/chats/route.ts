import db from '@/lib/db';

export const GET = async (req: Request) => {
  try {
    let chats = await db.query.chats.findMany();
    chats = chats.reverse();
    return Response.json({ chats: chats }, { status: 200 });
  } catch (err) {
    console.error('Error in getting chats: ', err);
    return Response.json({ message: 'Ocorreu um erro.' }, { status: 500 });
  }
};
