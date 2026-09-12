import ChatWindow from '@/components/ChatWindow';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Conversa - Vane',
  description: 'Converse com a internet, converse com o Vane.',
};

const Home = () => {
  return <ChatWindow />;
};

export default Home;
