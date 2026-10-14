import { SimpleGrid } from '@mantine/core';
import type { SerializedPhoto } from '../types/api';
import PhotoCard from './PhotoCard';

const PhotoGrid = ({ photos }: { photos: SerializedPhoto[] }) => (
  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
    {photos.map((photo) => (
      <PhotoCard key={photo.id} photo={photo} />
    ))}
  </SimpleGrid>
);

export default PhotoGrid;
