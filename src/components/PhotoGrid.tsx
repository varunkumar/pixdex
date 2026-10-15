import { SimpleGrid } from '@mantine/core';
import type { ReactNode } from 'react';
import type { SerializedPhoto } from '../types/api';
import PhotoCard from './PhotoCard';

const PhotoGrid = ({
  photos,
  footer,
}: {
  photos: SerializedPhoto[];
  footer?: (photo: SerializedPhoto) => ReactNode;
}) => (
  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
    {photos.map((photo) => (
      <PhotoCard key={photo.id} photo={photo} footer={footer?.(photo)} />
    ))}
  </SimpleGrid>
);

export default PhotoGrid;
