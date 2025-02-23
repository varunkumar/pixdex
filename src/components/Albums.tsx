import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Box,
  Button,
  Card,
  CardBody,
  Grid,
  Heading,
  Text,
  useDisclosure,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { apiClient } from '../services/api/ApiClient';

const Albums = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => apiClient.getAlbums(),
  });

  const clearAlbumMutation = useMutation({
    mutationFn: (album: string) => apiClient.clearAlbumIndex(album),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['albums'] });
      queryClient.invalidateQueries({ queryKey: ['photoStats'] });
      toast({
        title: 'Album index cleared',
        status: 'success',
        duration: 3000,
      });
    },
  });

  const clearAllMutation = useMutation({
    mutationFn: () => apiClient.clearAllIndices(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['albums'] });
      queryClient.invalidateQueries({ queryKey: ['photoStats'] });
      onClose();
      toast({
        title: 'All indices cleared',
        status: 'success',
        duration: 3000,
      });
    },
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Heading size="lg">Albums</Heading>
        <Button colorScheme="red" onClick={onOpen}>
          Clear All Indices
        </Button>
      </Box>

      <Grid templateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={6}>
        {albums.map((album) => (
          <Card key={album}>
            <CardBody>
              <Box
                display="flex"
                justifyContent="space-between"
                alignItems="center"
              >
                <Text fontSize="lg">{album}</Text>
                <Button
                  size="sm"
                  colorScheme="red"
                  onClick={() => clearAlbumMutation.mutate(album)}
                  isLoading={clearAlbumMutation.isPending}
                >
                  Clear Index
                </Button>
              </Box>
            </CardBody>
          </Card>
        ))}
      </Grid>

      <AlertDialog
        isOpen={isOpen}
        leastDestructiveRef={cancelRef}
        onClose={onClose}
      >
        <AlertDialogOverlay>
          <AlertDialogContent>
            <AlertDialogHeader>Clear All Indices</AlertDialogHeader>
            <AlertDialogBody>
              Are you sure? This will remove all photo indices from both SQLite
              and ChromaDB. This action cannot be undone.
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button ref={cancelRef} onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorScheme="red"
                onClick={() => clearAllMutation.mutate()}
                isLoading={clearAllMutation.isPending}
                ml={3}
              >
                Clear All
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialog>
    </VStack>
  );
};

export default Albums;
