import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Restaurants from './pages/Restaurants';
import RestaurantDetail from './pages/RestaurantDetail';
import Trips from './pages/Trips';
import TripDetail from './pages/TripDetail';
import Accounts from './pages/Accounts';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/restaurants" replace />} />
        <Route path="/restaurants" element={<Restaurants />} />
        <Route path="/restaurants/:id" element={<RestaurantDetail />} />
        <Route path="/trips" element={<Trips />} />
        <Route path="/trips/:id" element={<TripDetail />} />
        <Route path="/accounts" element={<Accounts />} />
      </Route>
    </Routes>
  );
}
